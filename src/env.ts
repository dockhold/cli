// Endpoints the CLI talks to. Defaults point at the hosted service.
//
// The API host for the interactive commands (login, deploy, logs, list, open)
// resolves in this order:
//   1. DOCKHOLD_API_URL in the environment (a person typing it in a terminal);
//   2. the host saved in the config file by the last `login`;
//   3. the default.
// The saved host exists so that a token and the host it belongs to travel
// together: a login against a different environment must not leave a token
// that a later plain `deploy` silently sends to the wrong place. Any command
// that ends up on a saved, non-default host says so on stderr.
//
// `dockhold mcp` does NOT use this resolver. It ignores the environment on
// purpose; see src/commands/mcp.ts for why.

export const DEFAULT_API_URL = "https://api.dockhold.eu";
export const DEFAULT_DASHBOARD_URL = "https://app.dockhold.eu";
export const DEFAULT_APP_DOMAIN = "dockhold.app";

export type HostSource = "env" | "saved" | "default";

export interface ResolvedHost {
  url: string;
  source: HostSource;
}

export function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export function resolveApiUrl(
  env: Record<string, string | undefined>,
  saved: string | null | undefined,
): ResolvedHost {
  const fromEnv = env.DOCKHOLD_API_URL?.trim();
  if (fromEnv) return { url: trimSlashes(fromEnv), source: "env" };
  const fromFile = saved?.trim();
  if (fromFile) return { url: trimSlashes(fromFile), source: "saved" };
  return { url: DEFAULT_API_URL, source: "default" };
}

// hostNotice is the one stderr line a command prints when it is about to use
// a host that came from the config file and is not the default. The person
// did not type that host in this terminal, so they get told.
export function hostNotice(host: ResolvedHost): string | null {
  if (host.source === "saved" && host.url !== DEFAULT_API_URL) return `Using API host ${host.url}`;
  return null;
}

export function dashboardUrl(env: Record<string, string | undefined> = process.env): string {
  return trimSlashes(env.DOCKHOLD_DASHBOARD_URL?.trim() || DEFAULT_DASHBOARD_URL);
}

// The apex your app is served under. Only used to build a fallback link when
// the server has not reported an endpoint yet.
export function appDomain(env: Record<string, string | undefined> = process.env): string {
  return env.DOCKHOLD_APP_DOMAIN?.trim() || DEFAULT_APP_DOMAIN;
}
