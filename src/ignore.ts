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
import { lstatSync, readFileSync } from "node:fs";
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
// relative path suitable for the ignore matcher. Only on Windows is `\` a
// separator; elsewhere it is part of a name (a folder can be called `a\b`).
export function toRel(p: string): string {
  let s = process.platform === "win32" ? p.replace(/\\/g, "/") : p;
  if (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/+$/, "");
  return s;
}

// A folder's view of the ignore files: `chain` holds the subfolder rules on its
// own chain (each parent folder's `.gitignore` from the top down, then its own,
// rebased to the root), and `matcher` the root `.gitignore`, that chain and
// `.dockholdignore`, in that order. The last matching rule wins across files
// exactly as it does within one, which is git's precedence. Adding one Ignore
// to another copies references to its compiled rules, so each line is
// compiled once however many folders reuse it.
interface Scope {
  chain: Ignore;
  matcher: Ignore;
}

// PackIgnore answers "does the ignore-file layer exclude this path?" for the
// pack filter. A path is tested with the scope of the folder it sits in, so a
// rule is only ever tested against paths inside its own folder. Cost per path
// is the rules on its chain, not every rule in the project, and a folder that
// has no `.gitignore` shares its parent's scope.
//
// Subfolder files are read lazily: the filter calls enter() on each folder it
// keeps, before tar reads that folder's contents (tar filters a folder when it
// stats it, and lists it only after). A folder that is excluded is never
// entered, so a `.gitignore` inside it is never read, which matches git (a path
// inside an excluded folder cannot be brought back).
//
// The filter runs inside tar's callbacks, where a throw would crash the
// process. So a problem is recorded instead (fail): the path is left out and
// packDirectory throws `failure` once tar is done.
export class PackIgnore {
  private readonly scopes = new Map<string, Scope>();
  private readonly root: Ignore;
  private readonly dockhold: Ignore;
  private failed: Error | null = null;

  constructor(root: string, dockhold: string, private readonly cwd: string) {
    this.root = ignore().add(root);
    this.dockhold = ignore().add(dockhold);
    this.scopes.set("", this.scope(ignore()));
  }

  get failure(): Error | null {
    return this.failed;
  }

  // fail records the first problem; packDirectory throws it after tar is done.
  fail(message: string): void {
    this.failed ??= new Error(`Could not apply your ignore files: ${message}`);
  }

  // ignores tests rel (relative to the root, not the root itself). A folder is
  // tested with a trailing slash only: that form matches every rule the bare
  // path does, plus folder-only rules ("dist/"), and lets a folder-only negation
  // ("!*/" after "*") keep the folder, as git does.
  ignores(rel: string, isDir: boolean): boolean {
    const scope = this.scopeFor(parentOf(rel));
    return scope === null || scope.matcher.ignores(isDir ? rel + "/" : rel);
  }

  // enter reads `<dir>/.gitignore`, if there is one, so its rules apply to
  // everything under dir. It returns false when the folder must be left out
  // because the file could not be read.
  enter(dir: string): boolean {
    const parent = this.scopeFor(parentOf(dir));
    if (parent === null) return false;
    let raw: string | null;
    try {
      raw = readGitignore(join(this.cwd, dir, ".gitignore"));
    } catch (e) {
      this.fail(`could not read ${dir}/.gitignore: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    const own = (raw ?? "")
      .split(/\r?\n/)
      .map((line) => rebasePattern(line, dir))
      .filter((p): p is string => p !== null);
    this.scopes.set(dir, own.length === 0 ? parent : this.scope(ignore().add(parent.chain).add(own)));
    return true;
  }

  // scopeFor returns the scope of an entered folder. A folder that was not
  // entered means tar listed it before filtering it, which would let its
  // `.gitignore` arrive too late; that is a failure, never a guess.
  private scopeFor(dir: string): Scope | null {
    const scope = this.scopes.get(dir);
    if (scope === undefined) {
      this.fail(`${dir} was listed before it was checked. This is a bug in the CLI; please report it.`);
    }
    return scope ?? null;
  }

  private scope(chain: Ignore): Scope {
    return { chain, matcher: ignore().add(this.root).add(chain).add(this.dockhold) };
  }
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

// readGitignore returns a `.gitignore` file's text without a leading UTF-8 byte
// order mark (git drops it too), or null when there is nothing to read: no
// file, or not a regular file. That includes a symbolic link, because git does
// not follow a linked `.gitignore` in the work tree and applies no rules from
// it. Any other error is thrown, so a file we fail to read never silently
// lets through what it excludes.
function readGitignore(path: string): string | null {
  let isFile: boolean;
  try {
    isFile = lstatSync(path).isFile();
  } catch (e) {
    if (isAbsent(e)) return null;
    throw e;
  }
  return isFile ? readFileSync(path, "utf8").replace(/^\uFEFF/, "") : null;
}

function isAbsent(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// loadIgnore reads the root `.gitignore` and `.dockholdignore`. An absent file
// adds nothing; any other read error is thrown. `.dockholdignore` is ours, not
// git's, so a link to it is followed. Subfolder `.gitignore` files are added by
// PackIgnore.enter.
export async function loadIgnore(cwd: string): Promise<PackIgnore> {
  const root = readGitignore(join(cwd, ".gitignore")) ?? "";
  let dockhold = "";
  try {
    dockhold = await readFile(join(cwd, ".dockholdignore"), "utf8");
  } catch (e) {
    if (!isAbsent(e)) throw e;
  }
  return new PackIgnore(root, dockhold, cwd);
}

// rebasePattern turns one line of `<dir>/.gitignore` into the same rule written
// from the root, or null for a blank line or a comment. Git's rules: a pattern
// with a slash at the start or in the middle is relative to the file's folder
// (`/build`, `a/b` -> `dir/build`, `dir/a/b`); one without (a trailing slash
// does not count) matches at any depth below it (`cache` -> `dir/**/cache`).
// A leading `!` stays in front. Characters in the folder name that mean
// something in a pattern are escaped, so `[x]` or `#notes` match themselves
// (`?` aside, see escapeDir).
export function rebasePattern(line: string, dir: string): string | null {
  // Trailing spaces are dropped unless escaped with a backslash.
  let body = line.replace(/(?<!\\) +$/, "");
  if (body === "" || body.startsWith("#")) return null;
  let negate = "";
  if (body.startsWith("!")) {
    negate = "!";
    body = body.slice(1);
  }
  let trimmed = body.endsWith("/") ? body.slice(0, -1) : body;
  if (trimmed === "") return null;
  // With no other slash, git reads `**` as `*`. Written out as `dir/**/**/`,
  // the ignore package would also match dir itself and drop all of it.
  if (trimmed === "**") {
    trimmed = "*";
    body = body.replace("**", "*");
  }
  const prefix = escapeDir(dir);
  if (body.startsWith("/")) return `${negate}${prefix}${body}`;
  if (trimmed.includes("/")) return `${negate}${prefix}/${body}`;
  return `${negate}${prefix}/**/${body}`;
}

// escapeDir leaves `?` as it is. The `ignore` package turns every `?` into "any
// one character", an escaped one too, so `\?` would match only a backslash and
// the folder's own `.gitignore` would never apply. Unescaped it is still exact:
// a folder's rules are only tested against paths inside that folder (see
// PackIgnore), where the only name in that place is the folder's own.
function escapeDir(dir: string): string {
  return dir.replace(/[\\*[\] ]/g, "\\$&").replace(/^[!#]/, "\\$&");
}
