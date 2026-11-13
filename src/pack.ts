// Packs the working directory into a gzipped archive for upload, applying the
// exclusion rules (see ignore.ts, including `.gitignore` files in subfolders), and returns the archive path, its sha256 (computed
// locally, then handed to the server for the presign + verify), and its size.
//
// The archive is written to a temp file, not held in memory: a project can be
// hundreds of MB (the default cap is 500 MB), and the file is streamed for both
// the hash and the upload. It lives inside a fresh mkdtemp directory (0700), so
// on a shared machine no other user can read the source archive, and the path
// is unguessable (a fixed name in the shared temp dir invites pre-creation).
// The caller removes the whole directory when done.

import { create } from "tar";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEnvFile, isHardExcluded, isValueFile, loadIgnore, toRel } from "./ignore.js";

// EnvFiles lists, by path from the project root and sorted, the env files the
// pack met, for the notice deploy prints. A folder left out is listed itself;
// what is inside it is never looked at.
export interface EnvFiles {
  envNames: string[]; // names that start with `.env`: never uploaded
  valueFiles: string[]; // value files left out (`prod.env`)
  valueFilesUploaded: string[]; // value files `.dockholdignore` brought back by name
}

export interface PackResult {
  archivePath: string;
  sha256: string;
  sizeBytes: number;
  env: EnvFiles;
}

export async function packDirectory(cwd: string): Promise<PackResult> {
  const ig = await loadIgnore(cwd);
  const env: EnvFiles = { envNames: [], valueFiles: [], valueFilesUploaded: [] };

  // keep decides one tar entry: true packs it, false leaves it out.
  const keep = (path: string, entry: unknown): boolean => {
    const rel = toRel(path);
    if (rel === "" || rel === ".") return true;
    const base = rel.split("/").pop() ?? rel;
    if (isEnvFile(base)) {
      env.envNames.push(rel);
      return false;
    }
    if (isHardExcluded(rel)) return false;
    const isDir = isDirectoryEntry(entry);
    const valueFile = !isDir && isValueFile(base);
    if (ig.ignores(rel, isDir) || (valueFile && !ig.bringsBack(rel))) {
      if (valueFile) env.valueFiles.push(rel);
      return false;
    }
    if (valueFile) env.valueFilesUploaded.push(rel);
    // A kept folder's own `.gitignore` applies to what tar finds inside it.
    return !isDir || ig.enter(rel);
  };

  const workDir = await mkdtemp(join(tmpdir(), "dockhold-"));
  const archivePath = join(workDir, "source.tgz");

  await create(
    {
      gzip: true,
      file: archivePath,
      cwd,
      portable: true, // stable mode/mtime → the same tree hashes the same
      // Returning false prunes an entry; for a directory tar also skips
      // descending into it, so excluding node_modules is cheap. The filter
      // runs inside tar's callbacks, where a throw would crash the process, so
      // any throw (the ignore package refuses some patterns) is recorded and
      // the entry left out.
      filter: (path: string, entry: unknown) => {
        try {
          return keep(path, entry);
        } catch (e) {
          ig.fail(`${toRel(path)}: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
      },
    },
    ["."],
  );
  // A problem inside the filter is recorded, not thrown (see PackIgnore): the
  // archive may be missing a folder, so it is never handed back.
  if (ig.failure) {
    await rm(workDir, { recursive: true, force: true });
    throw ig.failure;
  }

  const sha256 = await hashFile(archivePath);
  const sizeBytes = (await stat(archivePath)).size;
  for (const list of Object.values(env)) list.sort();
  return { archivePath, sha256, sizeBytes, env };
}

// tar's create filter passes an fs.Stats for a real file/dir; narrow to the
// isDirectory() we need without depending on tar's exported entry types.
function isDirectoryEntry(entry: unknown): boolean {
  const fn = (entry as { isDirectory?: unknown } | null)?.isDirectory;
  return typeof fn === "function" && (fn as () => boolean).call(entry);
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
