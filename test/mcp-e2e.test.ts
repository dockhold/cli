// End to end: the built `dist/index.js mcp`, stdin piped, against a local
// HTTPS server. The bridge only talks https, so the server gets a throwaway
// self-signed certificate from openssl, and the child trusts it through
// NODE_EXTRA_CA_CERTS (an environment variable Node reads, not the bridge).
// Certificate checks stay on: the bridge refuses to send a sign-in when they
// are off. The test is skipped where openssl is not installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const entry = join(root, "dist", "index.js");
const preload = join(here, "helpers", "stub-home.mjs");

const TOKEN = "dh_mcp_e2e_" + "e".repeat(28);
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
// `npm test` builds first (see package.json), so dist/ is there in CI.
const skip = !hasOpenssl ? "openssl is not installed" : !(await exists(entry)) ? "run npm run build first" : false;

async function selfSigned(dir: string): Promise<{ key: string; cert: string; certPath: string }> {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const r = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert,
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ]);
  assert.equal(r.status, 0, String(r.stderr));
  return { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8"), certPath: cert };
}

interface Seen {
  method: string;
  authorization: string | undefined;
  accept: string | undefined;
}

test("built CLI: stdout carries nothing but JSON-RPC; host and token come from the config file only", { skip }, async () => {
  const work = await mkdtemp(join(tmpdir(), "dockhold-e2e-"));
  const home = join(work, "home");
  const decoy = join(work, "decoy");
  try {
    const { key, cert, certPath } = await selfSigned(work);
    const seen: Seen[] = [];
    const server = https.createServer({ key, cert }, (req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const m = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
        seen.push({ method: m.method, authorization: req.headers.authorization, accept: req.headers.accept });
        if (!("id" in m)) {
          res.writeHead(202).end();
          return;
        }
        if (m.method === "tools/call" && req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid token" }));
          return;
        }
        const result =
          m.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "0" } }
            : m.method === "tools/list"
              ? { tools: [{ name: "list_apps", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: `called ${m.params?.name}` }], isError: false };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const host = `https://127.0.0.1:${port}`;

    // The real config, under the stubbed OS home, 0600 in 0700.
    await mkdir(join(home, ".config", "dockhold"), { recursive: true, mode: 0o700 });
    const cfgPath = join(home, ".config", "dockhold", "config.json");
    await writeFile(cfgPath, JSON.stringify({ token: TOKEN, apiUrl: host }), { mode: 0o600 });
    await chmod(cfgPath, 0o600);

    // A decoy config where HOME and XDG_CONFIG_HOME point, with a token the
    // server would reject. If the bridge read either variable, the tool call
    // below would come back 401.
    await mkdir(join(decoy, ".config", "dockhold"), { recursive: true, mode: 0o700 });
    await writeFile(join(decoy, ".config", "dockhold", "config.json"), JSON.stringify({ token: "dh_mcp_decoy_" + "d".repeat(24), apiUrl: host }), { mode: 0o600 });
    await mkdir(join(decoy, "xdg", "dockhold"), { recursive: true, mode: 0o700 });
    await writeFile(join(decoy, "xdg", "dockhold", "config.json"), JSON.stringify({ token: "dh_mcp_decoy_" + "x".repeat(24), apiUrl: host }), { mode: 0o600 });

    const child = spawn(process.execPath, ["--import", preload, entry, "mcp"], {
      cwd: work,
      env: {
        PATH: process.env.PATH ?? "",
        DOCKHOLD_TEST_HOME: home,
        NODE_EXTRA_CA_CERTS: certPath,
        // Everything below must be ignored by the bridge.
        HOME: decoy,
        XDG_CONFIG_HOME: join(decoy, "xdg"),
        DOCKHOLD_API_URL: "https://127.0.0.1:1",
        DOCKHOLD_DASHBOARD_URL: "https://127.0.0.1:1",
        DOCKHOLD_TOKEN: "dh_mcp_env_" + "v".repeat(28),
        DOCKHOLD_REF: "vscode",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_apps", arguments: {} } },
    ];
    child.stdin.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    server.close();

    assert.equal(code, 0, stderr);
    const out = stdout.split("\n").filter((l) => l.length > 0);
    assert.equal(out.length, 3, stdout);
    const byId = new Map<number, Record<string, unknown>>();
    for (const l of out) {
      const v = JSON.parse(l) as Record<string, unknown>;
      assert.equal(v.jsonrpc, "2.0");
      assert.ok("result" in v, l);
      byId.set(v.id as number, v);
    }
    assert.deepEqual([...byId.keys()].sort(), [1, 2, 3]);
    assert.equal(((byId.get(3)!.result as { content: { text: string }[] }).content[0]!.text), "called list_apps");
    assert.ok(!stdout.includes(TOKEN) && !stdout.includes("dh_mcp_"), "no token on stdout");

    // The server saw the bearer from the config file, on every message.
    assert.equal(seen.length, 4);
    for (const s of seen) {
      assert.equal(s.authorization, `Bearer ${TOKEN}`, s.method);
      assert.equal(s.accept, "application/json");
    }
    // The start line on stderr names the host and the real config path.
    assert.ok(stderr.includes(host) && stderr.includes(cfgPath), stderr);
    assert.ok(!stderr.includes(TOKEN));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("built CLI: no config means anonymous introspection and a local not-signed-in answer", { skip }, async () => {
  const work = await mkdtemp(join(tmpdir(), "dockhold-e2e-"));
  const home = join(work, "home");
  try {
    await mkdir(home, { recursive: true });
    // No server at all: a tool call without a sign-in must not need one.
    const child = spawn(process.execPath, ["--import", preload, entry, "mcp"], {
      cwd: work,
      env: { PATH: process.env.PATH ?? "", DOCKHOLD_TEST_HOME: home, DOCKHOLD_REF: "cursor" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_apps" } }) + "\n");
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    const out = stdout.split("\n").filter((l) => l.length > 0);
    assert.equal(out.length, 1, stdout);
    const v = JSON.parse(out[0]!) as { id: number; result: { isError: boolean; content: { text: string }[] } };
    assert.equal(v.id, 3);
    assert.equal(v.result.isError, true);
    assert.equal(v.result.content[0]!.text, 'Not signed in to Dockhold. Run "DOCKHOLD_REF=cursor npx dockhold login" in a terminal, then try again.');
    assert.ok(stderr.includes("https://api.dockhold.eu") && stderr.includes(join(home, ".config", "dockhold", "config.json")), stderr);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("built CLI: with certificate checks turned off, the sign-in is not sent and tool calls are refused", { skip }, async () => {
  const work = await mkdtemp(join(tmpdir(), "dockhold-e2e-"));
  const home = join(work, "home");
  try {
    await mkdir(join(home, ".config", "dockhold"), { recursive: true, mode: 0o700 });
    const cfgPath = join(home, ".config", "dockhold", "config.json");
    await writeFile(cfgPath, JSON.stringify({ token: TOKEN, apiUrl: "https://127.0.0.1:1" }), { mode: 0o600 });
    await chmod(cfgPath, 0o600);
    const child = spawn(process.execPath, ["--import", preload, entry, "mcp"], {
      cwd: work,
      env: { PATH: process.env.PATH ?? "", DOCKHOLD_TEST_HOME: home, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_apps" } }) + "\n");
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    const out = stdout.split("\n").filter((l) => l.length > 0);
    assert.equal(out.length, 1, stdout);
    const v = JSON.parse(out[0]!) as { id: number; result: { isError: boolean; content: { text: string }[] } };
    assert.equal(v.result.isError, true);
    assert.match(v.result.content[0]!.text, /NODE_TLS_REJECT_UNAUTHORIZED=0/);
    assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN));
    assert.ok(stderr.includes("NODE_TLS_REJECT_UNAUTHORIZED=0"), stderr);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
