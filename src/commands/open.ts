import { loadToken } from "../config.js";
import { listApps } from "../api.js";
import { appUrl } from "../appurl.js";
import { openBrowser } from "../browser.js";
import { resolveNamespace } from "../appref.js";
import { err, info } from "../output.js";

export async function open(args: string[]): Promise<number> {
  const namespace = await resolveNamespace(args, process.cwd());
  if (!namespace) {
    err('No app found here. Run "dockhold deploy" first, or pass --app <id>.');
    return 1;
  }

  // Prefer the server-reported endpoint when we can sign in; otherwise fall back
  // to the conventional host so `open` still works offline.
  let url = appUrl({ namespace });
  const token = await loadToken();
  if (token) {
    try {
      const app = (await listApps(token)).find((a) => a.namespace === namespace);
      if (app) url = appUrl(app);
    } catch {
      // fall back to the constructed URL
    }
  }

  info(`Opening ${url}`);
  openBrowser(url);
  return 0;
}
