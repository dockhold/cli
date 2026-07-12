// `dockhold deploy` — the whole push flow (local-deploy-spec §4, PR 4):
//   resolve/create app -> pack -> presign -> upload -> complete -> poll to done.

import { basename, dirname, join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { loadToken } from "../config.js";
import { readState, writeState, ensureGitignoreEntry } from "../state.js";
import { packDirectory, type PackResult } from "../pack.js";
import { sanitizeAppName, validateAppName } from "../name.js";
import {
  ApiError,
  complete,
  createApp,
  listApps,
  presign,
  uploadArchive,
} from "../api.js";
import { appUrl } from "../appurl.js";
import { envFlags, flagValue, hasFlag, mb, sleep } from "../args.js";
import { err, info } from "../output.js";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const UPLOAD_RETRIES = 3;

export async function deploy(args: string[]): Promise<number> {
  const cwd = process.cwd();

  const token = await loadToken();
  if (!token) {
    err("You are not signed in. Run: dockhold login");
    return 1;
  }

  // 1. Existing app in this folder, or create a new one.
  let state = await readState(cwd);
  if (!state) {
    const named = await resolveName(cwd, args);
    if (named.error) {
      err(named.error);
      return 1;
    }
    let namespace: string;
    try {
      namespace = await createApp(token, {
        name: named.value!,
        envVars: envFlags(args),
        withDatabase: hasFlag(args, "--db"),
      });
    } catch (e) {
      err(describe(e, "Could not create the app."));
      return 1;
    }
    state = { namespace, name: named.value!, created_at: new Date().toISOString() };
    await writeState(cwd, state);
    await ensureGitignoreEntry(cwd);
    info(`Created app "${state.name}".`);
  }
  const namespace = state.namespace;

  // 2. Pack the project.
  info("Packing your project.");
  let pack: PackResult;
  try {
    pack = await packDirectory(cwd);
  } catch (e) {
    err(describe(e, "Could not read your project files."));
    return 1;
  }

  try {
    if (pack.foundEnv) {
      info(
        "Found a .env file. Environment files are never uploaded. Set these as app variables with --env KEY=VALUE or in the dashboard.",
      );
    }

    // 3. Presign. The response carries the size cap, so refuse over-size here,
    //    before uploading a single byte (D8).
    let link;
    try {
      link = await presign(token, namespace, pack.sha256);
    } catch (e) {
      err(describe(e, "Could not prepare the upload."));
      return 1;
    }
    if (link.maxBytes > 0 && pack.sizeBytes > link.maxBytes) {
      err(
        `Your upload is over ${mb(link.maxBytes)} MB. Exclude build artifacts and dependency folders, then try again.`,
      );
      return 1;
    }

    // 4. Upload straight to the bucket, then confirm. Re-push once on the
    //    "incomplete" answer (a torn PUT leaves no object).
    info("Uploading.");
    const pushed = await uploadAndConfirm(token, namespace, pack, link.uploadUrl);
    if (!pushed.ok) {
      err(pushed.message);
      return 1;
    }
  } finally {
    // The archive lives in its own mkdtemp directory — remove the whole thing.
    await rm(dirname(pack.archivePath), { recursive: true, force: true }).catch(() => {});
  }

  // 5. Wait for the build to finish.
  info("Building. This can take a couple of minutes.");
  const result = await pollStatus(token, namespace);
  if (result.status === "RUNNING") {
    info(`\nYour app is live:\n  ${result.url}`);
    return 0;
  }
  if (result.status === "ERROR") {
    err(`\nThe deploy failed.${result.message ? "\n" + result.message : ""}`);
    return 1;
  }
  info('\nStill building. Check on it later with "dockhold list".');
  return 0;
}

interface ResolvedName {
  value?: string;
  error?: string;
}

// resolveName picks the app name: --name, then dockhold.json "name", then the
// sanitized folder name. It fails (rather than prompting) when nothing is
// derivable — interactivity breaks AI-tool usage (open-question 4).
async function resolveName(cwd: string, args: string[]): Promise<ResolvedName> {
  const explicit = flagValue(args, "--name");
  if (explicit) {
    const e = validateAppName(explicit);
    return e ? { error: e } : { value: explicit };
  }
  const fromJson = await dockholdJsonName(cwd);
  if (fromJson) {
    const e = validateAppName(fromJson);
    return e ? { error: e } : { value: fromJson };
  }
  const fromDir = sanitizeAppName(basename(cwd));
  if (!fromDir) {
    return { error: "Could not turn this folder name into an app name. Pass one with --name <name>." };
  }
  return { value: fromDir };
}

async function dockholdJsonName(cwd: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(join(cwd, "dockhold.json"), "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null;
  } catch {
    return null;
  }
}

type ConfirmResult = { ok: true } | { ok: false; message: string };

async function uploadAndConfirm(
  token: string,
  namespace: string,
  pack: PackResult,
  uploadUrl: string,
): Promise<ConfirmResult> {
  await uploadWithRetry(uploadUrl, pack.archivePath, pack.sizeBytes);
  let res = await complete(token, namespace, pack.sha256, pack.sizeBytes);
  if (res.ok) return { ok: true };

  if (res.kind === "incomplete") {
    // The object did not land. Ask for a fresh upload link before the one
    // re-push (the original could be close to, or past, its expiry after a
    // slow first upload), then confirm again.
    const fresh = await presign(token, namespace, pack.sha256);
    await uploadWithRetry(fresh.uploadUrl, pack.archivePath, pack.sizeBytes);
    res = await complete(token, namespace, pack.sha256, pack.sizeBytes);
    if (res.ok) return { ok: true };
  }
  if (res.kind === "too_large" && res.maxBytes) {
    return {
      ok: false,
      message: `Your upload is over ${mb(res.maxBytes)} MB. Exclude build artifacts and dependency folders, then try again.`,
    };
  }
  return { ok: false, message: res.message };
}

async function uploadWithRetry(url: string, path: string, size: number): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    try {
      await uploadArchive(url, path, size);
      return;
    } catch (e) {
      lastErr = e;
      const status = e instanceof ApiError ? e.status : 0;
      const retryable = status === 0 || status >= 500; // network error or server-side
      if (!retryable || attempt === UPLOAD_RETRIES) break;
      await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

interface PollResult {
  status: string;
  url: string;
  message?: string;
}

async function pollStatus(token: string, namespace: string): Promise<PollResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = "";
  while (Date.now() < deadline) {
    let apps;
    try {
      apps = await listApps(token);
    } catch {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const app = apps.find((a) => a.namespace === namespace);
    if (app) {
      if (app.status !== lastStatus) {
        info(`  ${app.status.toLowerCase()}`);
        lastStatus = app.status;
      }
      if (app.status === "RUNNING") return { status: "RUNNING", url: appUrl(app) };
      if (app.status === "ERROR") return { status: "ERROR", url: appUrl(app), message: app.error_message };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { status: lastStatus || "PENDING", url: "" };
}

function describe(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message || fallback;
  if (e instanceof Error && e.message) return `${fallback} (${e.message})`;
  return fallback;
}
