import { test } from "node:test";
import assert from "node:assert/strict";
import { PackIgnore, isEnvFile, isHardExcluded, isValueFile, rebasePattern, toRel } from "../src/ignore.js";

test("isEnvFile matches every name that starts with .env, in any case", () => {
  for (const name of [".env", ".env.local", ".env.production", ".envrc", ".env-local", ".env_prod", ".envs", ".ENV", ".ENVRC", ".Env.Local"]) {
    assert.ok(isEnvFile(name), name);
  }
  for (const name of ["env", "environment.ts", "prod.env", ".venv", "a.envrc", "x.env.local"]) {
    assert.ok(!isEnvFile(name), name);
  }
});

test("isValueFile matches value file names, in any case, and nothing else", () => {
  for (const name of ["prod.env", "production.env", "secrets.env", "PROD.ENV", "app.env.local", "prod.env.bak", "config.env.ts",
    "prod.env~", "prod.env-old", "prod.env_bak", "prod.env 2", "prod.env (copy)"]) {
    assert.ok(isValueFile(name), name);
  }
  // env.* is left alone on purpose: env.js and env.ts are source files.
  for (const name of ["env", "environment.ts", "vite-env.d.ts", "next-env.d.ts", "prodenv", "env.ts", "env.js", "envoy.yaml",
    "app.environment", "x.envoy", "prod.env2"]) {
    assert.ok(!isValueFile(name), name);
  }
});

test("isHardExcluded catches the non-negotiable paths at any depth", () => {
  assert.ok(isHardExcluded(".git/config"));
  assert.ok(isHardExcluded("node_modules/left-pad/index.js"));
  assert.ok(isHardExcluded("packages/api/node_modules/x"));
  assert.ok(isHardExcluded(".dockhold/app.json"));
  assert.ok(isHardExcluded(".env"));
  assert.ok(isHardExcluded("config/.env.local"));
  assert.ok(isHardExcluded(".envs/.production/.django"));
  assert.ok(isHardExcluded("sub/.ENVRC"));
  assert.ok(!isHardExcluded("src/index.ts"));
});

test("toRel normalizes tar entry paths", () => {
  assert.equal(toRel("./src/index.ts"), "src/index.ts");
  assert.equal(toRel("src/"), "src");
  // `\` is a separator only on Windows; elsewhere it is part of a name.
  assert.equal(toRel("a\\b"), process.platform === "win32" ? "a/b" : "a\\b");
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
  // A lone `**` is read as `*`, so the rule cannot match the folder itself.
  assert.equal(rebasePattern("**/", "s"), "s/**/*/");
  assert.equal(rebasePattern("**", "s"), "s/**/*");
  assert.equal(rebasePattern("!**/", "s"), "!s/**/*/");
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
  // one-character wildcard. It is only tested inside that folder, so it is exact.
  assert.equal(rebasePattern("s.txt", "q?"), "q?/**/s.txt");
});

test("PackIgnore fails, and leaves the path out, for a folder it was not shown first", () => {
  const ig = new PackIgnore("", "", "/nonexistent");
  assert.equal(ig.ignores("a", true), false, "control: a top-level folder is kept");
  assert.equal(ig.failure, null);
  assert.ok(ig.enter("a"));
  assert.equal(ig.ignores("a/f.txt", false), false, "control: inside an entered folder");
  assert.equal(ig.ignores("b/f.txt", false), true, "b was never entered");
  assert.match(String(ig.failure?.message), /b was listed before it was checked/);
});
