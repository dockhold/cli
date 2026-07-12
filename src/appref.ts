// Resolving which app a read/utility command targets: an explicit `--app <id>`
// wins, otherwise the `.dockhold/app.json` namespace in the current folder.

import { flagValue } from "./args.js";
import { readState } from "./state.js";

export async function resolveNamespace(args: string[], cwd: string): Promise<string | null> {
  const explicit = flagValue(args, "--app");
  if (explicit) return explicit;
  const state = await readState(cwd);
  return state?.namespace ?? null;
}
