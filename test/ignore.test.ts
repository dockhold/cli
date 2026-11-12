import { test } from "node:test";
import assert from "node:assert/strict";
import { isEnvFile, isHardExcluded, rebasePattern, toRel } from "../src/ignore.js";

test("isEnvFile matches .env and .env.*", () => {
  assert.ok(isEnvFile(".env"));
  assert.ok(isEnvFile(".env.local"));
  assert.ok(isEnvFile(".env.production"));
  assert.ok(!isEnvFile("env"));
  assert.ok(!isEnvFile("environment.ts"));
});

test("isHardExcluded catches the non-negotiable paths at any depth", () => {
  assert.ok(isHardExcluded(".git/config"));
  assert.ok(isHardExcluded("node_modules/left-pad/index.js"));
  assert.ok(isHardExcluded("packages/api/node_modules/x"));
  assert.ok(isHardExcluded(".dockhold/app.json"));
  assert.ok(isHardExcluded(".env"));
  assert.ok(isHardExcluded("config/.env.local"));
  assert.ok(!isHardExcluded("src/index.ts"));
});

test("toRel normalizes tar entry paths", () => {
  assert.equal(toRel("./src/index.ts"), "src/index.ts");
  assert.equal(toRel("src/"), "src");
  assert.equal(toRel("a\\b"), "a/b");
});

test("rebasePattern writes a subfolder's .gitignore line from the root", () => {
  // No slash, or only a trailing one: any depth below the folder.
  assert.equal(rebasePattern("*", ".secrets"), ".secrets/**/*");
  assert.equal(rebasePattern("cache", "a/b"), "a/b/**/cache");
  assert.equal(rebasePattern("dist/", "web"), "web/**/dist/");
  // A slash at the start or in the middle: relative to the folder.
  assert.equal(rebasePattern("/build", "web"), "web/build");
  assert.equal(rebasePattern("out/tmp", "web"), "web/out/tmp");
  assert.equal(rebasePattern("**/x.log", "web"), "web/**/x.log");
  // Negation stays in front.
  assert.equal(rebasePattern("!.gitignore", ".secrets"), "!.secrets/**/.gitignore");
  assert.equal(rebasePattern("!/keep", "web"), "!web/keep");
  // Blank lines and comments are not patterns.
  assert.equal(rebasePattern("", "web"), null);
  assert.equal(rebasePattern("   ", "web"), null);
  assert.equal(rebasePattern("# note", "web"), null);
  assert.equal(rebasePattern("/", "web"), null);
  // Unescaped trailing spaces are dropped; an escaped one is kept.
  assert.equal(rebasePattern("a.txt  ", "web"), "web/**/a.txt");
  assert.equal(rebasePattern("a\\ ", "web"), "web/**/a\\ ");
  // Pattern characters in the folder name are escaped.
  assert.equal(rebasePattern("s.txt", "[x]"), "\\[x\\]/**/s.txt");
  assert.equal(rebasePattern("s.txt", "#notes"), "\\#notes/**/s.txt");
  assert.equal(rebasePattern("s.txt", "!bang"), "\\!bang/**/s.txt");
  assert.equal(rebasePattern("s.txt", "a b"), "a\\ b/**/s.txt");
  // Except `?`: the ignore package cannot match a literal one, so it stays a
  // one-character wildcard (it still matches the folder itself).
  assert.equal(rebasePattern("s.txt", "q?"), "q?/**/s.txt");
});
