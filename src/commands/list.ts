import { loadToken } from "../config.js";
import { listApps } from "../api.js";
import { appUrl } from "../appurl.js";
import { err, info } from "../output.js";

export async function list(): Promise<number> {
  const token = await loadToken();
  if (!token) {
    err("You are not signed in. Run: dockhold login");
    return 1;
  }
  let apps;
  try {
    apps = await listApps(token);
  } catch (e) {
    err((e as Error).message || "Could not list your apps.");
    return 1;
  }
  if (apps.length === 0) {
    info('You have no apps yet. Run "dockhold deploy".');
    return 0;
  }
  for (const a of apps) {
    info(`${a.status.padEnd(14)} ${a.name.padEnd(24)} ${appUrl(a)}`);
  }
  return 0;
}
