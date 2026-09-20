// The `ref` slug: a short label that says where a sign-in came from (the CLI,
// an editor plugin, a docs page). It rides on the sign-in link and is stored
// once on the account, for grouping only. Clients that install the bridge set
// DOCKHOLD_REF in its environment; the slug is the ONE thing the bridge reads
// from the environment, which is why the pattern is strict: lowercase letters,
// digits and dashes, at most 32 of them. Anything else is dropped, never sent
// and never printed.

export const REF_PATTERN = /^[a-z0-9-]{1,32}$/;

export function validRef(env: Record<string, string | undefined>): string | null {
  const raw = env.DOCKHOLD_REF;
  return raw && REF_PATTERN.test(raw) ? raw : null;
}

export function refSlug(env: Record<string, string | undefined>, fallback = "cli"): string {
  return validRef(env) ?? fallback;
}
