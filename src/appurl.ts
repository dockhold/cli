import { APP_DOMAIN } from "./env.js";
import type { AppSummary } from "./api.js";

// appUrl prefers the server-reported endpoint (set once the app is RUNNING) and
// falls back to the conventional `<namespace>.<apex>` host before then.
export function appUrl(app: Pick<AppSummary, "namespace" | "endpoint_url">): string {
  if (app.endpoint_url) return app.endpoint_url;
  return `https://${app.namespace}.${APP_DOMAIN}`;
}
