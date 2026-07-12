// HTTP client for the server's `/cli/*` surface.
// Every authed call sends the deploy PAT as `Authorization: Bearer`. The archive
// itself does NOT go through here — it is PUT straight to a presigned upload URL,
// so the only large transfer bypasses the API entirely.

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { API_URL } from "./env.js";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // non-JSON body
  }
  return fallback;
}

// exchangeCode redeems the single-use login code for a deploy token. This route
// is unauthenticated by design — the code IS the credential.
export async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(`${API_URL}/cli/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res, "Sign-in failed"));
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new ApiError(500, "Server did not return a token");
  return body.token;
}

export interface CreateAppInput {
  name: string;
  envVars: Record<string, string>;
  withDatabase: boolean;
}

// createApp provisions an upload-source app and returns its namespace. No build
// runs yet; the app sits at AWAITING_SOURCE until the first source/complete.
export async function createApp(token: string, input: CreateAppInput): Promise<string> {
  const res = await fetch(`${API_URL}/cli/build`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      source_type: "upload",
      agent_name: input.name,
      env_vars: input.envVars,
      with_database: input.withDatabase,
    }),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res, "Could not create the app"));
  const body = (await res.json()) as { namespace?: string };
  if (!body.namespace) throw new ApiError(500, "Server did not return an app id");
  return body.namespace;
}

export interface PresignResult {
  uploadUrl: string;
  maxBytes: number;
}

export async function presign(token: string, namespace: string, sha256: string): Promise<PresignResult> {
  const res = await fetch(`${API_URL}/cli/apps/${encodeURIComponent(namespace)}/source/presign`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ sha256 }),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res, "Could not prepare the upload"));
  const body = (await res.json()) as { upload_url?: string; max_bytes?: number };
  if (!body.upload_url) throw new ApiError(500, "Server did not return an upload link");
  return { uploadUrl: body.upload_url, maxBytes: body.max_bytes ?? 0 };
}

// uploadArchive PUTs the archive straight to the presigned upload URL. A torn
// PUT never lands a partial upload (the PUT is atomic), so the caller may retry.
export async function uploadArchive(uploadUrl: string, archivePath: string, sizeBytes: number): Promise<void> {
  const stream = Readable.toWeb(createReadStream(archivePath)) as ReadableStream<Uint8Array>;
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-length": String(sizeBytes), "content-type": "application/octet-stream" },
    body: stream,
    // Streaming request bodies require duplex in undici; not yet in the DOM types.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!res.ok) throw new ApiError(res.status, `Upload failed (${res.status})`);
}

export type CompleteResult =
  | { ok: true }
  | { ok: false; kind: "incomplete" | "too_large" | "other"; message: string; maxBytes?: number };

// complete confirms the upload landed and kicks the build. 202 = building;
// 409 with code "source_missing" = the object is missing (retry the PUT);
// 413 = over the cap. The machine-readable `code` field is authoritative; the
// message regex is only a fallback for a controller that predates it.
export async function complete(
  token: string,
  namespace: string,
  sha256: string,
  sizeBytes: number,
): Promise<CompleteResult> {
  const res = await fetch(`${API_URL}/cli/apps/${encodeURIComponent(namespace)}/source/complete`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ sha256, size_bytes: sizeBytes }),
  });
  if (res.status === 202) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; max_bytes?: number };
  const message = body.error || "Could not finish the deploy";
  if (res.status === 409 && (body.code === "source_missing" || (!body.code && /incomplete/i.test(message)))) {
    return { ok: false, kind: "incomplete", message };
  }
  if (res.status === 413) return { ok: false, kind: "too_large", message, maxBytes: body.max_bytes };
  return { ok: false, kind: "other", message };
}

export interface AppSummary {
  namespace: string;
  name: string;
  status: string;
  endpoint_url?: string;
  error_message?: string;
  source_type?: string;
}

export async function listApps(token: string): Promise<AppSummary[]> {
  const res = await fetch(`${API_URL}/cli/apps`, { headers: authHeaders(token) });
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res, "Could not list your apps"));
  const body = (await res.json()) as { apps?: AppSummary[] };
  return body.apps ?? [];
}

export async function getLogs(
  token: string,
  namespace: string,
  opts: { type?: string; tail?: number } = {},
): Promise<string> {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.tail) params.set("tail", String(opts.tail));
  const qs = params.toString();
  const url = `${API_URL}/cli/apps/${encodeURIComponent(namespace)}/logs${qs ? "?" + qs : ""}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res, "Could not fetch logs"));
  const body = (await res.json()) as { logs?: string };
  return body.logs ?? "";
}
