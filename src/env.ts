// Endpoints the CLI talks to. Defaults point at production; the overrides let a
// developer aim the CLI at a different environment for testing.

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export const API_URL = trimSlashes(process.env.DOCKHOLD_API_URL || "https://api.dockhold.eu");
export const DASHBOARD_URL = trimSlashes(process.env.DOCKHOLD_DASHBOARD_URL || "https://app.dockhold.eu");

// The apex your app is served under. Only used to build a fallback link when the
// server has not reported an endpoint yet.
export const APP_DOMAIN = process.env.DOCKHOLD_APP_DOMAIN || "dockhold.app";
