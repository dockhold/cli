import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "../src/commands/login.js";
import { deploy } from "../src/commands/deploy.js";
import { logs } from "../src/commands/logs.js";
import { list } from "../src/commands/list.js";
import { open } from "../src/commands/open.js";
import { firstUnknownFlag } from "../src/help.js";

// Runs fn with fetch and the output streams captured. Any fetch call is
// recorded and answered with a failure, so a command that reaches the network
// shows up in `fetched`.
async function capture(fn: () => Promise<number>) {
  const fetched: string[] = [];
  const out: string[] = [];
  const errs: string[] = [];
  const realFetch = globalThis.fetch;
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  globalThis.fetch = (async (input: unknown) => {
    fetched.push(String(input));
    throw new Error("network is off in this test");
  }) as typeof fetch;
  process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => (errs.push(String(s)), true)) as typeof process.stderr.write;
  let code: number;
  try {
    code = await fn();
  } finally {
    globalThis.fetch = realFetch;
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, fetched, out: out.join(""), err: errs.join("") };
}

const commands: [string, (a: string[]) => Promise<number>][] = [
  ["login", (a) => login(a)],
  ["deploy", deploy],
  ["logs", logs],
  ["list", list],
  ["open", open],
];

for (const [name, run] of commands) {
  for (const flag of ["--help", "-h"]) {
    test(`${name} ${flag} prints usage and makes no network request`, async () => {
      const r = await capture(() => run([flag]));
      assert.equal(r.code, 0);
      assert.deepEqual(r.fetched, []);
      assert.ok(r.out.startsWith(`Usage: dockhold ${name}`), r.out);
      assert.equal(r.err, "");
    });
  }
}

test("help wins wherever it sits among the arguments", async () => {
  const r = await capture(() => deploy(["--name", "demo", "--db", "--help"]));
  assert.equal(r.code, 0);
  assert.deepEqual(r.fetched, []);
  assert.ok(r.out.startsWith("Usage: dockhold deploy"));
});

test("deploy --help creates no .dockhold folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dockhold-help-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    await capture(() => deploy(["--help"]));
    assert.deepEqual(await readdir(dir), []);
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown flag is refused by name, with a pointer to --help, before any request", async () => {
  const r = await capture(() => deploy(["--nmae", "x"]));
  assert.equal(r.code, 2);
  assert.deepEqual(r.fetched, []);
  assert.ok(r.err.includes("--nmae"));
  assert.ok(r.err.includes("dockhold deploy --help"));
});

test("every documented flag form is still accepted", () => {
  assert.equal(firstUnknownFlag("deploy", ["--name", "a", "--env", "K=V", "--env=K2=V2", "--db"]), null);
  assert.equal(firstUnknownFlag("deploy", ["--env", "K=-x"]), null);
  assert.equal(firstUnknownFlag("login", ["--token"]), null);
  assert.equal(firstUnknownFlag("login", ["--token", "dh_abc"]), null);
  assert.equal(firstUnknownFlag("login", ["--token=dh_abc"]), null);
  assert.equal(firstUnknownFlag("logs", ["--app", "x", "--tail", "5", "--type", "build", "--tail=7"]), null);
  assert.equal(firstUnknownFlag("open", ["--app", "x"]), null);
  assert.equal(firstUnknownFlag("list", []), null);
  assert.equal(firstUnknownFlag("deploy", ["extra-word"]), null);
});

// The built entry point: `mcp --help` must print usage instead of starting the
// bridge, and a deploy --help must never reach an API host.
test("the CLI binary prints help for every subcommand without contacting the API", async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.statusCode = 500;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const home = await mkdtemp(join(tmpdir(), "dockhold-help-bin-"));
  try {
    for (const cmd of ["login", "deploy", "logs", "list", "open", "mcp"]) {
      for (const flag of ["--help", "-h"]) {
        const child = spawn(process.execPath, [join(process.cwd(), "dist/index.js"), cmd, flag], {
          cwd: home,
          env: {
            ...process.env,
            HOME: home,
            DOCKHOLD_TOKEN: "dh_mcp_" + "t".repeat(30),
            DOCKHOLD_API_URL: `http://127.0.0.1:${port}`,
            DOCKHOLD_DASHBOARD_URL: `http://127.0.0.1:${port}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        const code: number = await new Promise((r) => child.on("close", (c) => r(c ?? -1)));
        assert.equal(code, 0, `${cmd} ${flag}`);
        assert.ok(out.startsWith(`Usage: dockhold ${cmd}`), `${cmd} ${flag}: ${out}`);
      }
    }
    assert.equal(hits, 0);
    assert.deepEqual(await readdir(home), []);
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});
