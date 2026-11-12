// Packing rules. Two layers:
//
//  1. Hard excludes that are NON-NEGOTIABLE: `.git`, `node_modules`, `.dockhold`,
//     and every `.env*` file. These are enforced directly, BEFORE any ignore
//     file is consulted, so a `.gitignore` negation (`!.env`) can never sneak a
//     secret file into the archive. There is no flag to include them.
//  2. The `.gitignore` files, read the way git reads them: the one at the root,
//     then one in any subfolder, whose patterns apply only inside that folder
//     and win over the folders above it. Then `.dockholdignore` (same syntax,
//     root only), added last so its patterns and negations WIN over them all.

import type { Ignore } from "ignore";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// `ignore` ships a CJS `module.exports = fn` with an ESM-shaped .d.ts, which the
// NodeNext resolver models as a namespace (its default import is not callable).
// createRequire hands back the real callable factory the runtime exports.
const ignore = createRequire(import.meta.url)("ignore") as (opts?: unknown) => Ignore;

// isEnvFile matches `.env` and `.env.<anything>` (the `.env*` glob).
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

// PackIgnore answers "does the ignore-file layer exclude this path?" for the
// pack filter. All patterns live in ONE matcher, in precedence order (root
// `.gitignore`, subfolder `.gitignore` files from the top down, `.dockholdignore`
// last), so the last matching pattern wins across files exactly as it does
// within one. A subfolder's patterns are rewritten to root-relative ones (see
// rebasePattern), which keeps them from matching anything outside it.
//
// Subfolder files are read lazily: the filter calls enter() on each folder it
// keeps, before tar reads that folder's contents. A folder that is excluded is
// never entered, so a `.gitignore` inside it is never read, which matches git
// (a path inside an excluded folder cannot be brought back).
export class PackIgnore {
  private matcher: Ignore;
  private readonly nested: string[] = [];

  constructor(
    private readonly cwd: string,
    private readonly root: string,
    private readonly dockhold: string,
  ) {
    this.matcher = this.build();
  }

  ignores(rel: string): boolean {
    return this.matcher.ignores(rel);
  }

  // enter reads `<dir>/.gitignore`, if there is one, so its patterns apply to
  // everything under dir. dir is relative to the root and not the root itself.
  enter(dir: string): void {
    let raw: string;
    try {
      raw = readFileSync(join(this.cwd, dir, ".gitignore"), "utf8");
    } catch {
      return; // absent (or not a file), nothing to add
    }
    const patterns = raw
      .split(/\r?\n/)
      .map((line) => rebasePattern(line, dir))
      .filter((p): p is string => p !== null);
    if (patterns.length === 0) return;
    // tar enters a folder before any folder inside it, so appending keeps the
    // shallower file ahead of the deeper one, which is the order git applies.
    this.nested.push(...patterns);
    this.matcher = this.build();
  }

  private build(): Ignore {
    return ignore().add(this.root).add(this.nested).add(this.dockhold);
  }
}

// loadIgnore reads the root `.gitignore` and `.dockholdignore`. Absent files are
// simply skipped. Subfolder `.gitignore` files are added by PackIgnore.enter.
export async function loadIgnore(cwd: string): Promise<PackIgnore> {
  const read = async (file: string) => {
    try {
      return await readFile(join(cwd, file), "utf8");
    } catch {
      return ""; // absent, nothing to add
    }
  };
  return new PackIgnore(cwd, await read(".gitignore"), await read(".dockholdignore"));
}

// rebasePattern turns one line of `<dir>/.gitignore` into the same rule written
// from the root, or null for a blank line or a comment. Git's rules: a pattern
// with a slash at the start or in the middle is relative to the file's folder
// (`/build`, `a/b` -> `dir/build`, `dir/a/b`); one without (a trailing slash
// does not count) matches at any depth below it (`cache` -> `dir/**/cache`).
// A leading `!` stays in front. Characters in the folder name that mean
// something in a pattern are escaped, so `[x]` or `#notes` match themselves,
// except `?` (see escapeDir).
export function rebasePattern(line: string, dir: string): string | null {
  // Trailing spaces are dropped unless escaped with a backslash.
  let body = line.replace(/(?<!\\) +$/, "");
  if (body === "" || body.startsWith("#")) return null;
  let negate = "";
  if (body.startsWith("!")) {
    negate = "!";
    body = body.slice(1);
  }
  const trimmed = body.endsWith("/") ? body.slice(0, -1) : body;
  if (trimmed === "") return null;
  const prefix = escapeDir(dir);
  if (body.startsWith("/")) return `${negate}${prefix}${body}`;
  if (trimmed.includes("/")) return `${negate}${prefix}/${body}`;
  return `${negate}${prefix}/**/${body}`;
}

// escapeDir leaves `?` as it is. The `ignore` package turns every `?` into "any
// one character", an escaped one too, so `\?` would match only a backslash and
// the folder's own `.gitignore` would never apply. Unescaped, it still applies
// to its folder, and at worst also to a sibling whose name differs in that one
// character: more is left out, never less.
function escapeDir(dir: string): string {
  return dir.replace(/[\\*[\] ]/g, "\\$&").replace(/^[!#]/, "\\$&");
}
