import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

    await rm(dirname(result.archivePath), { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("packDirectory writes the archive into a private per-run directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dockhold-pack-"));
  try {
    await writeFile(join(dir, "index.js"), "console.log('hi')\n");
    const result = await packDirectory(dir);
    const workDir = dirname(result.archivePath);

    // Not dropped straight into the shared temp dir under a guessable name.
    assert.notEqual(workDir, tmpdir());

    // The per-run directory is owner-only, so the source archive cannot be
    // read by other users on a shared machine (POSIX; skip the bit check on
    // Windows, where mode is not meaningful).
    if (process.platform !== "win32") {
      const mode = (await stat(workDir)).mode & 0o777;
      assert.equal(mode, 0o700, `expected 0700 work dir, got ${mode.toString(8)}`);
    }

    await rm(workDir, { recursive: true, force: true });
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
    await rm(dirname(result.archivePath), { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// files writes a tree from {"rel/path": "content"} under a fresh temp dir.
async function files(tree: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dockhold-pack-"));
  for (const [rel, content] of Object.entries(tree)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  return dir;
}

async function packed(tree: Record<string, string>): Promise<string[]> {
  const dir = await files(tree);
  try {
    const result = await packDirectory(dir);
    const names = await entriesOf(result.archivePath);
    await rm(dirname(result.archivePath), { recursive: true, force: true });
    return names;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("packDirectory honors a .gitignore in a subfolder that protects credentials", async () => {
  // The layout FastAgent scaffolds: the root .gitignore says nothing about
  // .secrets/, which carries its own .gitignore keeping everything but itself
  // and the template on the machine.
  const names = await packed({
    "index.js": "x\n",
    ".gitignore": "node_modules\n.fastagent\n",
    ".secrets/.gitignore": "*\n!.gitignore\n!.env.example\n",
    ".secrets/auth.json": '{"token":"t"}\n',
    ".secrets/production/.env": "KEY=v\n",
    ".secrets/production/notes.txt": "n\n",
  });
  assert.ok(names.includes("index.js"));
  assert.ok(names.includes(".secrets/.gitignore"), "the subfolder's own .gitignore is kept, as git keeps it");
  assert.ok(!names.includes(".secrets/auth.json"), "a file the subfolder's .gitignore excludes is not packed");
  assert.ok(!names.some((n) => n.startsWith(".secrets/production")), "nor a folder inside it");
});

test("packDirectory applies a subfolder's patterns only inside that folder", async () => {
  const names = await packed({
    "build/a.js": "x\n",
    "cache/c.txt": "x\n",
    "web/.gitignore": "/build\ncache\n",
    "web/build/a.js": "x\n",
    "web/src/build/b.js": "x\n",
    "web/src/cache/c.txt": "x\n",
  });
  assert.ok(names.includes("build/a.js"), "/build in web/.gitignore does not reach the root build/");
  assert.ok(names.includes("cache/c.txt"), "cache in web/.gitignore does not reach the root cache/");
  assert.ok(!names.includes("web/build/a.js"), "/build is anchored to web/");
  assert.ok(names.includes("web/src/build/b.js"), "/build matches only directly in web/");
  assert.ok(!names.includes("web/src/cache/c.txt"), "cache matches at any depth inside web/");
});

test("packDirectory lets a deeper .gitignore override a shallower one", async () => {
  const names = await packed({
    ".gitignore": "*.log\n",
    "app.log": "x\n",
    "sub/.gitignore": "!keep.log\n",
    "sub/keep.log": "x\n",
    "sub/other.log": "x\n",
  });
  assert.ok(!names.includes("app.log"));
  assert.ok(names.includes("sub/keep.log"), "the deeper negation wins");
  assert.ok(!names.includes("sub/other.log"));
});

test("packDirectory keeps .dockholdignore above every .gitignore", async () => {
  const names = await packed({
    ".dockholdignore": "!.secrets/public.txt\nsub/extra.txt\n",
    ".secrets/.gitignore": "*\n",
    ".secrets/public.txt": "x\n",
    ".secrets/auth.json": "x\n",
    "sub/.gitignore": "!extra.txt\n",
    "sub/extra.txt": "x\n",
  });
  assert.ok(names.includes(".secrets/public.txt"), ".dockholdignore brings a file back");
  assert.ok(!names.includes(".secrets/auth.json"));
  assert.ok(!names.includes("sub/extra.txt"), ".dockholdignore excludes over a subfolder's negation");
});

test("packDirectory reads no .gitignore inside an excluded folder", async () => {
  const names = await packed({
    ".gitignore": "vendor/\n",
    "vendor/.gitignore": "!*\n",
    "vendor/lib.js": "x\n",
    "app.js": "x\n",
  });
  assert.ok(names.includes("app.js"));
  assert.ok(!names.some((n) => n.startsWith("vendor")), "a path inside an excluded folder cannot be brought back");
});

test("packDirectory matches folder names that look like patterns literally", async () => {
  const names = await packed({
    "[x]/.gitignore": "secret.txt\n",
    "[x]/secret.txt": "x\n",
    "[x]/ok.txt": "x\n",
    "x/secret.txt": "x\n",
    "#notes/.gitignore": "s.txt\n",
    "#notes/s.txt": "x\n",
  });
  assert.ok(!names.includes("[x]/secret.txt"));
  assert.ok(names.includes("[x]/ok.txt"));
  assert.ok(names.includes("x/secret.txt"), "[x] is a folder name, not a character class");
  assert.ok(!names.includes("#notes/s.txt"), "#notes is a folder name, not a comment");
});
