import { loadToken } from "../config.js";
import { getLogs } from "../api.js";
import { resolveNamespace } from "../appref.js";
import { flagValue } from "../args.js";
import { err, info } from "../output.js";

export async function logs(args: string[]): Promise<number> {
  const token = await loadToken();
  if (!token) {
    err("You are not signed in. Run: dockhold login");
    return 1;
  }
  const namespace = await resolveNamespace(args, process.cwd());
  if (!namespace) {
    err('No app found here. Run "dockhold deploy" first, or pass --app <id>.');
    return 1;
  }
  const type = flagValue(args, "--type") || "app";
  const tailRaw = flagValue(args, "--tail");
  const tail = tailRaw && Number.isFinite(Number(tailRaw)) ? Number(tailRaw) : 100;

  try {
    const out = await getLogs(token, namespace, { type, tail });
    info(out.trim() ? out : "No logs yet.");
    return 0;
  } catch (e) {
    err((e as Error).message || "Could not fetch logs.");
    return 1;
  }
}
