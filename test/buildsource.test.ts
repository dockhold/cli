import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DETECTING_STACK_MESSAGE,
  hasOwnBuildFile,
  NO_DOCKERFILE_MESSAGE,
  refusesWithoutBuildFile,
} from "../src/buildsource.js";

async function folder(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "dockhold-buildsource-"));
}

test("a Dockerfile at the root counts", async () => {
  const dir = await folder();
  await writeFile(join(dir, "Dockerfile"), "FROM node:22-alpine\n");
  assert.equal(await hasOwnBuildFile(dir), true);
});

test("a dockhold.json naming a Dockerfile counts", async () => {
  const dir = await folder();
  await writeFile(join(dir, "dockhold.json"), JSON.stringify({ build: { dockerfile: "docker/Dockerfile" } }));
  assert.equal(await hasOwnBuildFile(dir), true);
});

test("an empty folder does not count", async () => {
  assert.equal(await hasOwnBuildFile(await folder()), false);
});

// The refusal is only correct when the check is: these all leave the build with
// nothing to start from, and a false "yes" here uploads into a failing build.
test("near misses do not count", async () => {
  const dir = await folder();
  await writeFile(join(dir, "dockhold.json"), JSON.stringify({ name: "my-app" }));
  assert.equal(await hasOwnBuildFile(dir), false, "dockhold.json without a build block");

  const blank = await folder();
  await writeFile(join(blank, "dockhold.json"), JSON.stringify({ build: { dockerfile: "  " } }));
  assert.equal(await hasOwnBuildFile(blank), false, "a blank dockerfile path");

  const broken = await folder();
  await writeFile(join(broken, "dockhold.json"), "{not json");
  assert.equal(await hasOwnBuildFile(broken), false, "unparseable dockhold.json");

  const nested = await folder();
  await mkdir(join(nested, "app"));
  await writeFile(join(nested, "app", "Dockerfile"), "FROM node:22-alpine\n");
  assert.equal(await hasOwnBuildFile(nested), false, "a Dockerfile below the root is not the one the build reads");

  const dirNamed = await folder();
  await mkdir(join(dirNamed, "Dockerfile"));
  assert.equal(await hasOwnBuildFile(dirNamed), false, "a directory named Dockerfile");
});

// The message is the whole point of checking early, so keep it actionable: the
// fix before the upsell, and a link to copy from.
test("the message states the fix before the upgrade", async () => {
  const fix = NO_DOCKERFILE_MESSAGE.indexOf("Add one to the root");
  const upsell = NO_DOCKERFILE_MESSAGE.indexOf("compute unit");
  assert.ok(fix > -1 && upsell > -1 && fix < upsell);
  assert.match(NO_DOCKERFILE_MESSAGE, /docs\/concepts\/dockerfiles/);
  assert.ok(!NO_DOCKERFILE_MESSAGE.includes("\u2014"), "no em-dashes in user-facing copy");
});

// The refusal keys on what the server reports, never on a plan name. Only a
// definite "no" on both counts refuses; an older server that says nothing
// gets the deploy it always got.
test("refusal needs a definite no on both capabilities", () => {
  assert.equal(refusesWithoutBuildFile({ autoBuild: false, autoBuildStacks: false }), true, "neither: refuse");
  assert.equal(refusesWithoutBuildFile({ autoBuild: false }), true, "old server without the stacks field: refuse as before");
  assert.equal(refusesWithoutBuildFile({ autoBuild: false, autoBuildStacks: true }), false, "free account, stacks detected: let the build decide");
  assert.equal(refusesWithoutBuildFile({ autoBuild: true, autoBuildStacks: false }), false, "paid account: never refused");
  assert.equal(refusesWithoutBuildFile({ autoBuild: true, autoBuildStacks: true }), false);
  assert.equal(refusesWithoutBuildFile({}), false, "older server, both unknown: not a refusal");
  assert.equal(refusesWithoutBuildFile({ autoBuildStacks: true }), false);
  assert.ok(!DETECTING_STACK_MESSAGE.includes("—"), "no em-dashes in user-facing copy");
});
