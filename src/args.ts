// Tiny argv helpers. No CLI framework (local-deploy-spec D7 — keep deps minimal),
// so flag parsing is done by hand.

// flagValue reads `--name value` or `--name=value`, returning the first match.
export function flagValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) {
    const v = args[i + 1];
    if (v !== undefined && !v.startsWith("--")) return v;
  }
  const eq = args.find((a) => a.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  return null;
}

// hasFlag reports whether a boolean flag is present.
export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

// envFlags collects every `--env KEY=VALUE` (repeatable) into a map. A value with
// no `=` or an empty key is skipped.
export function envFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (kv: string) => {
    const eq = kv.indexOf("=");
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--env" && i + 1 < args.length) {
      take(args[++i]!);
    } else if (a !== undefined && a.startsWith("--env=")) {
      take(a.slice("--env=".length));
    }
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// mb renders a byte cap as whole megabytes for user-facing size messages, so the
// copy never drifts from the server's configured limit (local-deploy-spec D11).
export function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
