// Packing rules (local-deploy-spec D8, trap #8). Two layers:
//
//  1. Hard excludes that are NON-NEGOTIABLE: `.git`, `node_modules`, `.dockhold`,
//     and every `.env*` file. These are enforced directly, BEFORE any ignore
//     file is consulted, so a `.gitignore` negation (`!.env`) can never sneak a
//     secret file into the archive. There is no flag to include them.
//  2. `.gitignore` (respected when present) plus `.dockholdignore` (same syntax,
//     added last so its patterns and negations WIN over `.gitignore`).

import type { Ignore } from "ignore";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// `ignore` ships a CJS `module.exports = fn` with an ESM-shaped .d.ts, which the
// NodeNext resolver models as a namespace (its default import is not callable).
// createRequire hands back the real callable factory the runtime exports.
const ignore = createRequire(import.meta.url)("ignore") as (opts?: unknown) => Ignore;

// isEnvFile matches `.env` and `.env.<anything>` (the `.env*` glob in D8).
export function isEnvFile(basename: string): boolean {
  return basename === ".env" || basename.startsWith(".env.");
}

const HARD_DIRS = new Set([".git", "node_modules", ".dockhold"]);

// isHardExcluded is true if ANY path segment is a hard-excluded dir or an env
// file. Segment-based so a nested `pkg/node_modules` or `sub/.env` is also
// caught.
export function isHardExcluded(rel: string): boolean {
  for (const seg of rel.split("/")) {
    if (HARD_DIRS.has(seg)) return true;
    if (isEnvFile(seg)) return true;
  }
  return false;
}

// toRel normalizes a tar entry path to a posix, no-leading-`./`, no-trailing-`/`
// relative path suitable for the ignore matcher.
export function toRel(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/+$/, "");
  return s;
}

// loadIgnore builds the matcher from `.gitignore` then `.dockholdignore` (last
// wins). Absent files are simply skipped.
export async function loadIgnore(cwd: string): Promise<Ignore> {
  const ig = ignore();
  for (const file of [".gitignore", ".dockholdignore"]) {
    try {
      ig.add(await readFile(join(cwd, file), "utf8"));
    } catch {
      // absent — nothing to add
    }
  }
  return ig;
}
