// Access-token storage. The token is a `dh_mcp_*` deploy-scoped PAT minted by the
// login exchange (local-deploy-spec D6). It is written 0600 under the user's
// config dir and NEVER logged.
//
// Resolution order at call time: DOCKHOLD_TOKEN env var (the D6 fallback / CI
// path) wins over the saved file.

import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "dockhold");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

export async function saveToken(token: string): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = configPath();
  await writeFile(path, JSON.stringify({ token }, null, 2) + "\n", { mode: 0o600 });
  // writeFile's mode only applies on create; force it in case the file existed.
  await chmod(path, 0o600);
}

export async function loadToken(): Promise<string | null> {
  const fromEnv = process.env.DOCKHOLD_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8")) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token ? parsed.token : null;
  } catch {
    return null;
  }
}
