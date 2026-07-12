import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState, ensureGitignoreEntry } from "../src/state.js";

test("writeState then readState round-trips the namespace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dockhold-state-"));
  try {
    assert.equal(await readState(dir), null);
    await writeState(dir, { namespace: "my-app-ab12cd", name: "my-app" });
    const state = await readState(dir);
    assert.equal(state?.namespace, "my-app-ab12cd");
    assert.equal(state?.name, "my-app");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureGitignoreEntry appends .dockhold/ only when a .gitignore exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dockhold-state-"));
  try {
    // No .gitignore -> no-op, and none is created.
    await ensureGitignoreEntry(dir);
    await assert.rejects(readFile(join(dir, ".gitignore"), "utf8"));

    await writeFile(join(dir, ".gitignore"), "node_modules/\n");
    await ensureGitignoreEntry(dir);
    let content = await readFile(join(dir, ".gitignore"), "utf8");
    assert.ok(content.includes(".dockhold/"));

    // Idempotent — a second call does not duplicate the entry.
    await ensureGitignoreEntry(dir);
    content = await readFile(join(dir, ".gitignore"), "utf8");
    assert.equal(content.match(/\.dockhold\//g)?.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
