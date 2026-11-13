import { test } from "node:test";
import assert from "node:assert/strict";
import { envNotice, failureMessage } from "../src/commands/deploy.js";

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

const noEnv = { envNames: [], valueFiles: [], valueFilesUploaded: [] };

test("the env notice is silent when the pack met no env file", () => {
  assert.equal(envNotice(noEnv), null);
});

test("the env notice names what stayed home and says a .env name has no way back", () => {
  const msg = envNotice({ ...noEnv, envNames: [".env", ".envrc"] }) ?? "";
  assert.ok(msg.includes("Left out environment files: .env, .envrc."));
  assert.ok(msg.includes("--env KEY=VALUE"));
  assert.ok(msg.includes("never uploaded"));
  assert.ok(!msg.includes(".dockholdignore"), "no hint that cannot work");
});

test("the env notice gives the exact line that brings a value file back", () => {
  const msg = envNotice({ ...noEnv, valueFiles: ["a*b.env", "sub/prod.env"] }) ?? "";
  assert.ok(msg.includes("To upload sub/prod.env, add the line !/sub/prod.env to .dockholdignore."), msg);
  assert.ok(!msg.includes("never uploaded"));
});

test("the env notice names value files that go up, caps long lists, and shows no control characters", () => {
  const msg = envNotice({
    envNames: [".env", ".env.a", ".env.b", ".env.c"],
    valueFiles: ["x\u001b[2Jy.env", "z.env"],
    valueFilesUploaded: ["defaults.env"],
  }) ?? "";
  assert.ok(msg.includes("and 1 more."), msg);
  assert.ok(!msg.includes("\u001b"), "escape code shown as ?");
  assert.ok(msg.includes("x?[2Jy.env"));
  assert.ok(msg.includes("add the line !/z.env"), "the example skips a name that is not literal");
  assert.ok(msg.includes("Uploading defaults.env because .dockholdignore names it."));
});
