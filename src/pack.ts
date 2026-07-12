// Packs the working directory into a gzipped archive for upload, applying the
// D8 exclusion rules, and returns the archive path, its sha256 (computed
// locally, then handed to the server for the presign + verify), and its size.
//
// The archive is written to a temp file, not held in memory — a project can be
// hundreds of MB (the default cap is 500 MB), and the file is streamed for both
// the hash and the upload.

import { create } from "tar";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEnvFile, isHardExcluded, loadIgnore, toRel } from "./ignore.js";

export interface PackResult {
  archivePath: string;
  sha256: string;
  sizeBytes: number;
  foundEnv: boolean; // true if a .env* file was seen (and skipped) — drives the D8 notice
}

export async function packDirectory(cwd: string): Promise<PackResult> {
  const ig = await loadIgnore(cwd);
  let foundEnv = false;

  const archivePath = join(tmpdir(), `dockhold-source-${process.pid}-${Date.now()}.tgz`);

  await create(
    {
      gzip: true,
      file: archivePath,
      cwd,
      portable: true, // stable mode/mtime → the same tree hashes the same
      // Returning false prunes an entry; for a directory tar also skips
      // descending into it, so excluding node_modules is cheap.
      filter: (path: string, entry: unknown) => {
        const rel = toRel(path);
        if (rel === "" || rel === ".") return true;
        const base = rel.split("/").pop() ?? rel;
        if (isEnvFile(base)) {
          foundEnv = true;
          return false;
        }
        if (isHardExcluded(rel)) return false;
        // A directory-only gitignore rule ("dist/") matches the dir path with a
        // trailing slash, so test that form too when the entry is a directory.
        const isDir = isDirectoryEntry(entry);
        if (ig.ignores(rel) || (isDir && ig.ignores(rel + "/"))) return false;
        return true;
      },
    },
    ["."],
  );

  const sha256 = await hashFile(archivePath);
  const sizeBytes = (await stat(archivePath)).size;
  return { archivePath, sha256, sizeBytes, foundEnv };
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
