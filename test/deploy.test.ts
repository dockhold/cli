import { test } from "node:test";
import assert from "node:assert/strict";
import { failureMessage } from "../src/commands/deploy.js";

test("a failed deploy prints the server's reason and where to look next", () => {
  const msg = failureMessage("build failed: no start script");
  assert.ok(msg.includes("The deploy failed."));
  assert.ok(msg.includes("build failed: no start script"));
  assert.ok(msg.includes('Run "npx dockhold logs --type build" to see why.'));
});

test("the hint is printed even when the server gave no reason", () => {
  const msg = failureMessage(undefined);
  assert.ok(msg.includes("The deploy failed."));
  assert.ok(msg.endsWith('Run "npx dockhold logs --type build" to see why.'));
  assert.ok(!msg.includes("\n\n\n"));
});
