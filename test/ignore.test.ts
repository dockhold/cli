import { test } from "node:test";
import assert from "node:assert/strict";
import { isEnvFile, isHardExcluded, toRel } from "../src/ignore.js";

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
