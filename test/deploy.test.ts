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
  assert.ok(msg.includes("Left out environment files: .env, .envrc."), msg);
  assert.ok(msg.includes("--env KEY=VALUE"));
  assert.ok(msg.includes("never uploaded"));
  assert.ok(!msg.includes(".dockholdignore"), "no hint that cannot work");
});

test("the env notice gives the exact line that brings a value file back", () => {
  const msg = envNotice({ ...noEnv, valueFiles: ["a*b.env", "sub/prod.env"] }) ?? "";
  assert.ok(msg.includes("Left out value files: a*b.env, sub/prod.env."), msg);
  assert.ok(msg.includes("To upload sub/prod.env, add the line !/sub/prod.env at the end of .dockholdignore."), msg);
  assert.ok(!msg.includes("never uploaded"));
});

test("the env notice names value files that go up, caps only the .env list, and shows no hidden characters", () => {
  const valueFiles = ["a0.env", "a1.env", "a2.env", "a3.env", "a4.env", "a5.env", "src/client.env.ts", "x\u001b[2Jy.env", "y\u2028\u202e.env", "z.env"];
  const msg = envNotice({
    envNames: [".env", ".env.a", ".env.b", ".env.c", ".env.d", ".env.e"],
    valueFiles,
    valueFilesUploaded: ["defaults.env"],
  }) ?? "";
  assert.ok(msg.includes(".env.d and 1 more."), msg);
  assert.ok(msg.includes("src/client.env.ts"), "every value file is named, so a left-out source file is visible");
  assert.ok(!/[\u001b\u2028\u202e]/.test(msg), "hidden characters shown as ?");
  assert.ok(msg.includes("x?[2Jy.env") && msg.includes("y??.env"));
  assert.ok(msg.includes("add the line !/a0.env at the end"), msg);
  assert.ok(msg.includes("Uploading defaults.env because .dockholdignore names it."));
});
