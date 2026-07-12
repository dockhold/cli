// Per-project state: `.dockhold/app.json` records the namespace (the canonical
// app id) so a second `dockhold deploy` in the same folder pushes a new version
// of the SAME app instead of creating a duplicate. On first create we also add
// `.dockhold/` to an existing `.gitignore` (never create one — that's the user's
// call).

import { join } from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

export interface AppState {
  namespace: string;
  name?: string;
  created_at?: string;
}

function stateDir(cwd: string): string {
  return join(cwd, ".dockhold");
}

function statePath(cwd: string): string {
  return join(stateDir(cwd), "app.json");
}

export async function readState(cwd: string): Promise<AppState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(cwd), "utf8")) as AppState;
    if (parsed && typeof parsed.namespace === "string" && parsed.namespace) return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function writeState(cwd: string, state: AppState): Promise<void> {
  await mkdir(stateDir(cwd), { recursive: true });
  await writeFile(statePath(cwd), JSON.stringify(state, null, 2) + "\n");
}

// ensureGitignoreEntry appends `.dockhold/` to an EXISTING `.gitignore`. It does
// nothing when there is no `.gitignore` (the folder may not be a git repo at
// all) and is idempotent.
export async function ensureGitignoreEntry(cwd: string, entry = ".dockhold/"): Promise<void> {
  const gitignore = join(cwd, ".gitignore");
  try {
    await access(gitignore);
  } catch {
    return; // no .gitignore — leave the folder alone
  }
  const raw = await readFile(gitignore, "utf8");
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(".dockhold")) return;
  const sep = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
  await writeFile(gitignore, raw + sep + entry + "\n");
}
