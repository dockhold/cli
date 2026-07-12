import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTokenShape } from "../src/config.js";

test("validateTokenShape accepts a dh_mcp_ token", () => {
  assert.equal(validateTokenShape("dh_mcp_" + "a".repeat(32)), null);
});

test("validateTokenShape rejects junk", () => {
  assert.ok(validateTokenShape(""));
  assert.ok(validateTokenShape("not-a-token"));
  assert.ok(validateTokenShape("dh_mcp_"), "too short to be real");
  assert.ok(validateTokenShape("ghp_" + "a".repeat(32)), "wrong prefix");
});

test("validateTokenShape rejects whitespace from a mangled paste", () => {
  assert.ok(validateTokenShape("dh_mcp_abc def" + "a".repeat(20)));
  assert.ok(validateTokenShape("dh_mcp_abc\n" + "a".repeat(20)));
});
