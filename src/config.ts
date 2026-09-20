// Sign-in storage: `~/.config/dockhold/config.json` holds the access token (a
// `dh_mcp_*` deploy-scoped token minted by the login exchange) and the API host
// that token belongs to. It is written 0600 in a 0700 folder and NEVER logged.
//
// Where "~" comes from matters. This file is read by `dockhold mcp`, which an
// editor starts with an environment that a cloned repository's MCP config can
// set. If the path depended on HOME or XDG_CONFIG_HOME, a repo could point the
// bridge at a config file planted inside the repo, and a deploy from that
// editor would upload the user's source into someone else's account. So the
// home directory comes from the operating system's own record of the user
// (os.userInfo(), the passwd entry on POSIX) and not from os.homedir(), which
// reads HOME first. `login` writes to the same place so the two always agree.
//
// Token resolution for the interactive commands: DOCKHOLD_TOKEN in the
// environment (the CI path) wins over the saved file. The bridge does not use
// that path; see src/commands/mcp.ts.

import os from "node:os";
import { dirname, join } from "node:path";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { trimSlashes } from "./env.js";

// Access tokens are dh_mcp_* PATs. Checking the shape before saving turns a
// typo'd paste into an immediate, plain error instead of a 401 on the next
// deploy. Returns a human error string, or null when the token looks right.
export function validateTokenShape(token: string): string | null {
  if (!token) return "No token given.";
  if (!token.startsWith("dh_mcp_") || token.length < 20) {
    return 'That does not look like a Dockhold access token (they start with "dh_mcp_"). Copy it again and retry.';
  }
  if (/\s/.test(token)) return "The token contains spaces or line breaks. Copy it as one line and retry.";
  return null;
}

export function configPathFor(home: string): string {
  return join(home, ".config", "dockhold", "config.json");
}

// osHomeDir is the home directory the operating system reports for the
// current user. It throws when the OS has no record of one (a container
// running as a uid with no passwd entry, for example).
export function osHomeDir(): string {
  const home = os.userInfo().homedir;
  if (!home) throw new Error("the operating system reported no home directory");
  return home;
}

// The interactive commands fall back to os.homedir() when the OS has no record
// of the user, so the CLI still works in a bare container. The bridge does
// not fall back: for it, an unknown home means no config.
function interactiveHomeDir(): string {
  try {
    return osHomeDir();
  } catch {
    return os.homedir();
  }
}

export interface StoredConfig {
  token: string | null;
  apiUrl: string | null;
}

function parseConfig(raw: string): StoredConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("not a JSON object");
  }
  const obj = parsed as { token?: unknown; apiUrl?: unknown };
  const token = typeof obj.token === "string" && obj.token.trim() ? obj.token.trim() : null;
  const apiUrl = typeof obj.apiUrl === "string" && obj.apiUrl.trim() ? trimSlashes(obj.apiUrl.trim()) : null;
  return { token, apiUrl };
}

// saveConfig writes the token and the API host it was issued by, together.
// Returns the path written.
export async function saveConfig(
  cfg: { token: string; apiUrl: string },
  home: string = interactiveHomeDir(),
): Promise<string> {
  const path = configPathFor(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ token: cfg.token, apiUrl: cfg.apiUrl }, null, 2) + "\n", {
    mode: 0o600,
  });
  // writeFile's mode only applies on create; force it in case the file existed.
  await chmod(path, 0o600);
  return path;
}

// loadConfig is the lenient reader for the interactive commands: a missing or
// unreadable file is simply "not signed in".
export async function loadConfig(home: string = interactiveHomeDir()): Promise<StoredConfig> {
  try {
    return parseConfig(await readFile(configPathFor(home), "utf8"));
  } catch {
    return { token: null, apiUrl: null };
  }
}

export async function loadToken(): Promise<string | null> {
  const fromEnv = process.env.DOCKHOLD_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return (await loadConfig()).token;
}

// ---------------------------------------------------------------------------
// Checked reader, used by `dockhold mcp`.
//
// Beyond taking the path from the OS home, the bridge applies the checks ssh
// applies to its own files before trusting what it reads: the file must be a
// regular file, mode 0600, in a 0700 folder, both owned by the current user.
// A file that fails is treated as if it did not exist, and the reason is
// returned so the bridge can say it on stderr. The mode and owner checks are
// skipped on Windows, which has no POSIX mode bits.
// ---------------------------------------------------------------------------

export type ConfigRead =
  | { ok: true; path: string; token: string | null; apiUrl: string | null }
  | { ok: false; path: string | null; reason: string };

export interface CheckedReadOptions {
  homedir: () => string;
  platform?: NodeJS.Platform;
  uid?: () => number | undefined;
  stat?: typeof stat;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
}

export async function readConfigChecked(opts: CheckedReadOptions): Promise<ConfigRead> {
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid ?? (() => process.getuid?.());
  const statFn = opts.stat ?? stat;
  const readFn = opts.readFile ?? ((p, enc) => readFile(p, enc));

  let home: string;
  try {
    home = opts.homedir();
  } catch (e) {
    return { ok: false, path: null, reason: `could not determine your home directory (${(e as Error).message})` };
  }
  const path = configPathFor(home);

  let fileStat;
  try {
    fileStat = await statFn(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, path, token: null, apiUrl: null };
    return { ok: false, path, reason: `could not read it (${(e as Error).message})` };
  }
  if (!fileStat.isFile()) return { ok: false, path, reason: "it is not a regular file" };

  if (platform !== "win32") {
    const me = uid();
    if (me !== undefined && fileStat.uid !== me) return { ok: false, path, reason: "it is not owned by you" };
    if ((fileStat.mode & 0o077) !== 0) {
      return { ok: false, path, reason: `it is readable by other users (mode ${octal(fileStat.mode)}, expected 600)` };
    }
    let dirStat;
    try {
      dirStat = await statFn(dirname(path));
    } catch (e) {
      return { ok: false, path, reason: `could not read its folder (${(e as Error).message})` };
    }
    if (me !== undefined && dirStat.uid !== me) return { ok: false, path, reason: "its folder is not owned by you" };
    if ((dirStat.mode & 0o077) !== 0) {
      return { ok: false, path, reason: `its folder is open to other users (mode ${octal(dirStat.mode)}, expected 700)` };
    }
  }

  let parsed: StoredConfig;
  try {
    parsed = parseConfig(await readFn(path, "utf8"));
  } catch (e) {
    return { ok: false, path, reason: `it is not valid JSON (${(e as Error).message})` };
  }
  return { ok: true, path, token: parsed.token, apiUrl: parsed.apiUrl };
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8);
}
