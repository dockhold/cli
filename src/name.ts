// Client-side mirror of the controller's sanitizeAppName / ValidateAppName
// (apps/controller/main.go). Kept byte-for-byte in step so the CLI can derive a
// name from a folder and fail fast with the same rules the server enforces
// (local-deploy-spec PR 4). If the Go rules change, change these too.

export const APP_NAME_MAX_RAW = 64; // appNameMaxRawLen
export const APP_NAME_MAX_CLEAN = 52; // appNameMaxCleanLen

// sanitizeAppName maps a raw name to the DNS-1123 slug the server would produce:
// lowercase; a-z0-9 kept; `_`, space and `-` become `-`; everything else
// dropped; runs of `-` collapsed; trimmed; truncated to APP_NAME_MAX_CLEAN.
export function sanitizeAppName(name: string): string {
  const lowered = name.trim().toLowerCase();
  let out = "";
  for (const ch of lowered) {
    if (ch >= "a" && ch <= "z") out += ch;
    else if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "-" || ch === "_" || ch === " ") out += "-";
  }
  while (out.includes("--")) out = out.replaceAll("--", "-");
  out = out.replace(/^-+/, "").replace(/-+$/, "");
  if (out.length > APP_NAME_MAX_CLEAN) {
    out = out.slice(0, APP_NAME_MAX_CLEAN).replace(/-+$/, "");
  }
  return out;
}

// validateAppName returns a human error string, or null when the name is fine.
// Mirrors ValidateAppName so `dockhold deploy --name` rejects locally instead of
// after a round-trip.
export function validateAppName(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "app name is required";
  if (t.length > APP_NAME_MAX_RAW) return `app name is too long (max ${APP_NAME_MAX_RAW} characters)`;
  if (sanitizeAppName(t) === "") return "app name must contain at least one letter or digit";
  return null;
}
