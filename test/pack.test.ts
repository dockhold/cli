import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { list } from "tar";
import { packDirectory } from "../src/pack.js";

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dockhold-pack-"));
  await writeFile(join(dir, "index.js"), "console.log('hi')\n");
  await writeFile(join(dir, ".env"), "SECRET=shh\n");
  await writeFile(join(dir, ".env.local"), "SECRET=shh\n");
  await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
  await writeFile(join(dir, "node_modules", "dep", "index.js"), "module.exports={}\n");
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "dist", "bundle.js"), "//built\n");
  await writeFile(join(dir, ".gitignore"), "dist/\n");
  await writeFile(join(dir, "keep.txt"), "keep me\n");
  return dir;
}

async function entriesOf(archivePath: string): Promise<string[]> {
  const names: string[] = [];
  await list({
    file: archivePath,
    onentry: (e) => {
      names.push(e.path.replace(/^\.\//, "").replace(/\/$/, ""));
    },
  });
  return names;
}

test("packDirectory excludes secrets, deps, git, and gitignored paths", async () => {
  const dir = await fixture();
  try {
    const result = await packDirectory(dir);
    assert.ok(result.foundEnv, "should notice a .env file");
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.ok(result.sizeBytes > 0);

    const names = await entriesOf(result.archivePath);
    assert.ok(names.includes("index.js"));
    assert.ok(names.includes("keep.txt"));

    // Never packed
    assert.ok(!names.some((n) => n === ".env" || n === ".env.local"));
    assert.ok(!names.some((n) => n.startsWith("node_modules")));
    assert.ok(!names.some((n) => n.startsWith(".git/") || n === ".git"));
    assert.ok(!names.some((n) => n.startsWith("dist")), ".gitignore should exclude dist/");

    await rm(result.archivePath, { force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("packDirectory honors .dockholdignore over .gitignore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dockhold-pack-"));
  try {
    await writeFile(join(dir, "a.txt"), "a\n");
    await writeFile(join(dir, "b.txt"), "b\n");
    await writeFile(join(dir, ".gitignore"), "b.txt\n");
    // dockholdignore adds its own exclusion (a.txt) on top of gitignore's (b.txt)
    await writeFile(join(dir, ".dockholdignore"), "a.txt\n");
    const result = await packDirectory(dir);
    const names = await entriesOf(result.archivePath);
    assert.ok(!names.includes("a.txt"), ".dockholdignore exclusion applies");
    assert.ok(!names.includes("b.txt"), ".gitignore exclusion still applies");
    await rm(result.archivePath, { force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
