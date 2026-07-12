import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeAppName, validateAppName, APP_NAME_MAX_CLEAN } from "../src/name.js";

test("sanitizeAppName mirrors the server slug rules", () => {
  assert.equal(sanitizeAppName("Price Bot"), "price-bot");
  assert.equal(sanitizeAppName("price_bot"), "price-bot");
  assert.equal(sanitizeAppName("price--bot"), "price-bot");
  assert.equal(sanitizeAppName("  -Hello-  "), "hello");
  assert.equal(sanitizeAppName("café ☕ app"), "caf-app");
  assert.equal(sanitizeAppName("中文"), "");
});

test("sanitizeAppName truncates and trims to the clean length", () => {
  const long = "a".repeat(80);
  assert.equal(sanitizeAppName(long).length, APP_NAME_MAX_CLEAN);
  // truncation must not leave a trailing hyphen
  const trailing = "a".repeat(APP_NAME_MAX_CLEAN) + "-more";
  assert.ok(!sanitizeAppName(trailing).endsWith("-"));
});

test("validateAppName accepts a normal name", () => {
  assert.equal(validateAppName("my-app"), null);
});

test("validateAppName rejects empty, too-long, and unusable names", () => {
  assert.match(validateAppName("")!, /required/);
  assert.match(validateAppName("x".repeat(65))!, /too long/);
  assert.match(validateAppName("中文")!, /at least one letter or digit/);
});
