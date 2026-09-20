import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createBridge, runMcp, type BridgeDeps } from "../src/commands/mcp.js";
import type { ConfigRead } from "../src/config.js";

// A token that must never show up on stdout or in any answer text.
const TOKEN = "dh_mcp_test_" + "s3cr3t".repeat(6);
const HOST = "https://api.example.test";
const DEFAULT_HOST = "https://api.dockhold.eu";
const PATH = "/home/someone/.config/dockhold/config.json";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
  init: RequestInit;
}

type Handler = (call: Call, n: number) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function empty(status: number): Response {
  return new Response(null, { status });
}

// echo answers like the real server does for the simple methods: a result for
// initialize/ping/tools/list, an echoing tool result for tools/call, 202 for
// notifications, and the anonymous refusal for a tools/call with no bearer.
const echo: Handler = (call) => {
  const parsed = JSON.parse(call.body) as Record<string, unknown> | Record<string, unknown>[];
  const answer = (m: Record<string, unknown>) => {
    if (!("id" in m)) return null;
    if (m.method === "tools/call" && !call.headers.authorization) {
      return { jsonrpc: "2.0", id: m.id, error: { code: -32001, message: "authentication required" } };
    }
    if (m.method === "tools/call") {
      return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "called" }], isError: false } };
    }
    return { jsonrpc: "2.0", id: m.id, result: { ok: true, method: m.method } };
  };
  if (Array.isArray(parsed)) {
    const out = parsed.map(answer).filter((r) => r !== null);
    if (out.length === 0) return empty(202);
    return json(200, out.length === 1 ? out[0] : out);
  }
  const one = answer(parsed);
  return one ? json(200, one) : empty(202);
};

interface Harness {
  bridge: ReturnType<typeof createBridge>;
  calls: Call[];
  stderr: string[];
  setConfig(c: ConfigRead): void;
}

function harness(
  opts: { config?: ConfigRead; handler?: Handler; env?: Record<string, string | undefined>; refusal?: string } = {},
): Harness {
  let config: ConfigRead = opts.config ?? { ok: true, path: PATH, token: TOKEN, apiUrl: HOST };
  const handler = opts.handler ?? echo;
  const calls: Call[] = [];
  const stderr: string[] = [];
  const deps: BridgeDeps = {
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      const call = { url, headers, body: String(init.body), init };
      calls.push(call);
      return handler(call, calls.length);
    },
    readConfig: async () => config,
    stderr: (line) => stderr.push(line),
    env: opts.env ?? {},
    refusal: opts.refusal,
  };
  return { bridge: createBridge(deps), calls, stderr, setConfig: (c) => (config = c) };
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
const toolsList = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const toolCall = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_apps", arguments: {} } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function line(v: unknown): string {
  return JSON.stringify(v);
}

function parseLine(out: string | null): Record<string, unknown> {
  assert.ok(out !== null, "expected an output line");
  assert.ok(!out.includes("\n"), "one line");
  return JSON.parse(out) as Record<string, unknown>;
}

function toolErrorText(out: string | null): string {
  const r = parseLine(out);
  const result = r.result as { content: { type: string; text: string }[]; isError: boolean };
  assert.equal(result.isError, true, "isError");
  assert.equal(result.content[0]?.type, "text");
  return result.content[0]!.text;
}

test("forwards a single request byte-for-byte with JSON headers", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { a: 1, b: [1, 2, { c: "x" }] } });
  const h = harness({ handler: () => new Response(body, { status: 200 }) });
  const out = await h.bridge.handleLine(line(init));
  assert.equal(out, body);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.url, HOST + "/mcp");
  assert.equal(h.calls[0]!.init.method, "POST");
  assert.equal(h.calls[0]!.init.redirect, "manual");
  assert.equal(h.calls[0]!.headers.accept, "application/json");
  assert.equal(h.calls[0]!.headers["content-type"], "application/json");
  assert.equal(h.calls[0]!.body, line(init));
});

test("forwards a batch array byte-for-byte", async () => {
  const body = JSON.stringify([
    { jsonrpc: "2.0", id: 1, result: { x: 1 } },
    { jsonrpc: "2.0", id: 2, result: { tools: [] } },
  ]);
  const h = harness({ handler: () => new Response(body, { status: 200 }) });
  const out = await h.bridge.handleLine(line([init, toolsList]));
  assert.equal(out, body);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.body, line([init, toolsList]));
});

test("a body with a line break is re-serialized onto one line", async () => {
  const pretty = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }, null, 2);
  const h = harness({ handler: () => new Response(pretty, { status: 200 }) });
  const out = await h.bridge.handleLine(line(init));
  assert.ok(out && !out.includes("\n"));
  assert.deepEqual(JSON.parse(out!), JSON.parse(pretty));
});

test("token present: initialize, tools/list and tools/call all carry the bearer", async () => {
  const h = harness();
  await h.bridge.handleLine(line(init));
  await h.bridge.handleLine(line(toolsList));
  await h.bridge.handleLine(line(toolCall));
  assert.equal(h.calls.length, 3);
  for (const c of h.calls) assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
});

test("token absent: no Authorization header at all on introspection; tools/call answers locally", async () => {
  const h = harness({ config: { ok: true, path: PATH, token: null, apiUrl: HOST } });
  const a = parseLine(await h.bridge.handleLine(line(init)));
  assert.equal(a.id, 1);
  parseLine(await h.bridge.handleLine(line(toolsList)));
  parseLine(await h.bridge.handleLine(line({ jsonrpc: "2.0", id: 9, method: "ping" })));
  assert.equal(h.calls.length, 3);
  for (const c of h.calls) assert.ok(!("authorization" in c.headers), "header must be absent, not empty");

  const out = await h.bridge.handleLine(line(toolCall));
  assert.equal(h.calls.length, 3, "tools/call made no HTTP call");
  const r = parseLine(out);
  assert.equal(r.id, 3);
  assert.equal(toolErrorText(out), 'Not signed in to Dockhold. Run "npx dockhold login" in a terminal, then try again.');
});

test("token absent: a valid DOCKHOLD_REF is carried into the login hint, an invalid one is not", async () => {
  const good = harness({ config: { ok: true, path: PATH, token: null, apiUrl: HOST }, env: { DOCKHOLD_REF: "cursor" } });
  assert.equal(
    toolErrorText(await good.bridge.handleLine(line(toolCall))),
    'Not signed in to Dockhold. Run "DOCKHOLD_REF=cursor npx dockhold login" in a terminal, then try again.',
  );
  for (const bad of ["Cursor", "a b", "x".repeat(33), "$(rm -rf ~)", "../x", ""]) {
    const h = harness({ config: { ok: true, path: PATH, token: null, apiUrl: HOST }, env: { DOCKHOLD_REF: bad } });
    const text = toolErrorText(await h.bridge.handleLine(line(toolCall)));
    assert.equal(text, 'Not signed in to Dockhold. Run "npx dockhold login" in a terminal, then try again.', bad);
    assert.ok(!text.includes(bad) || bad === "", "nothing from the environment leaks into the text");
  }
});

test("token appears after start: the next call uses it (config re-read per message)", async () => {
  const h = harness({ config: { ok: true, path: PATH, token: null, apiUrl: HOST } });
  toolErrorText(await h.bridge.handleLine(line(toolCall)));
  assert.equal(h.calls.length, 0);
  h.setConfig({ ok: true, path: PATH, token: TOKEN, apiUrl: HOST });
  const out = parseLine(await h.bridge.handleLine(line(toolCall)));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal((out.result as { isError: boolean }).isError, false);
});

test("401 on tools/call becomes the expired tool error, without the token", async () => {
  const h = harness({ handler: () => json(401, { error: "invalid token" }) });
  const out = await h.bridge.handleLine(line(toolCall));
  assert.equal(toolErrorText(out), 'Your Dockhold sign-in has expired. Run "npx dockhold login" and try again.');
  assert.ok(!out!.includes(TOKEN));
  assert.equal(h.calls.length, 1, "no anonymous retry for a tool call");
});

test("401 on a non-tool request becomes a JSON-RPC error with the expired message", async () => {
  const h = harness({ handler: () => json(401, { error: "invalid token" }), env: { DOCKHOLD_REF: "vscode" } });
  const out = await h.bridge.handleLine(line({ jsonrpc: "2.0", id: 7, method: "resources/list" }));
  const r = parseLine(out);
  assert.equal(r.id, 7);
  assert.deepEqual(r.error, { code: -32001, message: 'Your Dockhold sign-in has expired. Run "DOCKHOLD_REF=vscode npx dockhold login" and try again.' });
  assert.ok(!out!.includes(TOKEN));
});

test("-32029 inside a 200 body is reworded as busy", async () => {
  const h = harness({ handler: (c) => json(200, { jsonrpc: "2.0", id: JSON.parse(c.body).id, error: { code: -32029, message: "rate limit exceeded" } }) });
  const out = parseLine(await h.bridge.handleLine(line(toolsList)));
  assert.deepEqual(out.error, { code: -32029, message: "Dockhold is busy, try again in a few seconds." });
});

test("-32029 is reworded in every element of a batch answer", async () => {
  const h = harness({
    handler: () =>
      json(200, [
        { jsonrpc: "2.0", id: 1, result: { ok: true } },
        { jsonrpc: "2.0", id: 2, error: { code: -32029, message: "rate limit exceeded" } },
      ]),
  });
  const out = JSON.parse((await h.bridge.handleLine(line([init, toolsList])))!) as { error?: { message: string } }[];
  assert.equal(out[1]!.error!.message, "Dockhold is busy, try again in a few seconds.");
});

test("403 passes the server's text through unchanged, as a tool error for tools/call", async () => {
  const h = harness({ handler: () => json(403, { error: "account suspended" }) });
  assert.equal(toolErrorText(await h.bridge.handleLine(line(toolCall))), "account suspended");
  const r = parseLine(await h.bridge.handleLine(line(toolsList)));
  assert.deepEqual(r.error, { code: -32001, message: "account suspended" });
});

test("a scope error in a 200 body passes through unchanged", async () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    result: { content: [{ type: "text", text: 'This token does not have permission to use "set_app_secret". It needs the "secrets" scope.' }], isError: true },
  });
  const h = harness({ handler: () => new Response(body, { status: 200 }) });
  const out = await h.bridge.handleLine(line(toolCall));
  assert.equal(out, body);
  assert.ok(!out!.includes(TOKEN));
});

test("no answer text ever contains the token", async () => {
  const cases: Handler[] = [
    () => json(401, { error: "invalid token" }),
    () => json(403, { error: "account suspended" }),
    () => json(503, { error: "mcp server feature is disabled" }),
    () => new Response("<html>bad gateway</html>", { status: 502 }),
    () => new Response("not json", { status: 200 }),
    () => empty(302),
    () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    },
  ];
  for (const handler of cases) {
    const h = harness({ handler });
    for (const msg of [toolCall, toolsList]) {
      const out = await h.bridge.handleLine(line(msg));
      assert.ok(out !== null);
      assert.ok(!out.includes(TOKEN), "token in output");
      const r = parseLine(out);
      assert.equal(r.id, (msg as { id: number }).id);
      assert.ok("result" in r || "error" in r);
    }
  }
});

test("a redirect is an error, never followed", async () => {
  const h = harness({ handler: () => new Response(null, { status: 301, headers: { location: "https://elsewhere.example/mcp" } }) });
  const r = parseLine(await h.bridge.handleLine(line(toolsList)));
  assert.equal((r.error as { code: number }).code, -32000);
  assert.match((r.error as { message: string }).message, /redirect/);
  assert.equal(h.calls.length, 1);
});

test("a notification is forwarded and nothing is written", async () => {
  const h = harness();
  const out = await h.bridge.handleLine(line(initialized));
  assert.equal(out, null);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.body, line(initialized));
});

test("a client response (no method) is dropped, not forwarded", async () => {
  const h = harness();
  const out = await h.bridge.handleLine(line({ jsonrpc: "2.0", id: 5, result: {} }));
  assert.equal(out, null);
  assert.equal(h.calls.length, 0);
});

test("a line that is not JSON gets a parse error without a round trip", async () => {
  const h = harness();
  const r = parseLine(await h.bridge.handleLine("{not json"));
  assert.equal(r.id, null);
  assert.equal((r.error as { code: number }).code, -32700);
  assert.equal(h.calls.length, 0);
});

test("dead token: 401 on initialize is retried without the header; the next tools/call reports expiry", async () => {
  const h = harness({
    handler: (c) => {
      if (c.headers.authorization) return json(401, { error: "invalid token" });
      return echo(c, 0);
    },
  });
  const a = parseLine(await h.bridge.handleLine(line(init)));
  assert.equal(a.id, 1);
  assert.ok("result" in a, "handshake succeeded");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!("authorization" in h.calls[1]!.headers));

  const b = parseLine(await h.bridge.handleLine(line(toolsList)));
  assert.ok("result" in b);

  const out = await h.bridge.handleLine(line(toolCall));
  assert.equal(toolErrorText(out), 'Your Dockhold sign-in has expired. Run "npx dockhold login" and try again.');
  assert.equal(h.calls.length, 5, "tools/call was sent once with the bearer and not retried");
  assert.equal(h.calls[4]!.headers.authorization, `Bearer ${TOKEN}`);
  for (const c of h.calls) assert.ok(!c.body.includes(TOKEN));
  assert.ok(!out!.includes(TOKEN));
});

test("dead token: a batch of initialize plus a notification is still retried once without the header", async () => {
  const h = harness({
    handler: (c) => {
      if (c.headers.authorization) return json(401, { error: "invalid token" });
      return echo(c, 0);
    },
  });
  const out = await h.bridge.handleLine(line([init, initialized]));
  // A batch answer is always an array, even when only one element answered.
  const arr = JSON.parse(out!) as Record<string, unknown>[];
  assert.equal(arr.length, 1);
  assert.equal(arr[0]!.id, 1);
  assert.ok("result" in arr[0]!);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!("authorization" in h.calls[1]!.headers));

  // A batch carrying a tool call is not retried anonymously.
  const mixed = await h.bridge.handleLine(line([init, toolCall]));
  const both = JSON.parse(mixed!) as Record<string, unknown>[];
  assert.equal(both.length, 2);
  assert.equal(h.calls.length, 3);
});

test("environment host, token and dashboard are ignored: the host comes from the config", async () => {
  const h = harness({
    env: {
      DOCKHOLD_API_URL: "https://attacker.example",
      DOCKHOLD_DASHBOARD_URL: "https://attacker.example",
      DOCKHOLD_TOKEN: "dh_mcp_from_env_" + "x".repeat(24),
    },
  });
  await h.bridge.handleLine(line(toolCall));
  assert.equal(h.calls[0]!.url, HOST + "/mcp");
  assert.equal(h.calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
});

test("a config with an http:// host is refused: stderr, tool error, no request to it", async () => {
  const h = harness({ config: { ok: true, path: PATH, token: TOKEN, apiUrl: "http://api.example.test" } });
  await h.bridge.announce();
  assert.ok(h.stderr.some((l) => l.includes("not a plain https address") && l.includes(PATH)), h.stderr.join("\n"));

  const text = toolErrorText(await h.bridge.handleLine(line(toolCall)));
  assert.match(text, /not a plain https address/);
  assert.equal(h.calls.length, 0, "no request for the tool call");

  // The client can still start: introspection goes to the default host, anonymously.
  parseLine(await h.bridge.handleLine(line(init)));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.url, DEFAULT_HOST + "/mcp");
  assert.ok(!("authorization" in h.calls[0]!.headers));
  for (const c of h.calls) assert.ok(!c.url.startsWith("http://"));
});

test("a saved host with credentials, a query, a fragment or a bad scheme is refused; a plain one is normalised", async () => {
  for (const bad of [
    "https://user:pw@api.example.test",
    "https://user@api.example.test",
    "https://api.example.test/?x=1",
    "https://api.example.test/#frag",
    "ftp://api.example.test",
    "http://api.example.test",
    "not a url",
    "https://",
  ]) {
    const h = harness({ config: { ok: true, path: PATH, token: TOKEN, apiUrl: bad } });
    assert.match(toolErrorText(await h.bridge.handleLine(line(toolCall))), /not a plain https address/, bad);
    assert.equal(h.calls.length, 0, bad);
  }
  const h = harness({ config: { ok: true, path: PATH, token: TOKEN, apiUrl: "HTTPS://API.Example.test:8443/base/" } });
  await h.bridge.handleLine(line(toolCall));
  assert.equal(h.calls[0]!.url, "https://api.example.test:8443/base/mcp");
});

test("a refusal from the process (certificate checks off) blocks tool calls and keeps the sign-in at home", async () => {
  const refusal = "NODE_TLS_REJECT_UNAUTHORIZED=0 is set for this server, so the sign-in stays home.";
  const h = harness({ refusal });
  await h.bridge.announce();
  assert.equal(h.stderr.length, 1);
  assert.ok(h.stderr[0]!.includes(refusal) && h.stderr[0]!.includes(DEFAULT_HOST));

  assert.equal(toolErrorText(await h.bridge.handleLine(line(toolCall))), refusal);
  assert.equal(h.calls.length, 0);

  parseLine(await h.bridge.handleLine(line(init)));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.url, DEFAULT_HOST + "/mcp");
  assert.ok(!("authorization" in h.calls[0]!.headers));
  assert.equal(h.stderr.length, 1);
});

test("a config that fails its checks is treated as no config; stderr names the path and reason", async () => {
  const h = harness({ config: { ok: false, path: PATH, reason: "it is readable by other users (mode 644, expected 600)" } });
  await h.bridge.announce();
  assert.equal(h.stderr.length, 1);
  assert.ok(h.stderr[0]!.includes(PATH) && h.stderr[0]!.includes("mode 644"));

  parseLine(await h.bridge.handleLine(line(init)));
  assert.equal(h.calls[0]!.url, DEFAULT_HOST + "/mcp");
  assert.ok(!("authorization" in h.calls[0]!.headers));
  assert.equal(toolErrorText(await h.bridge.handleLine(line(toolCall))), 'Not signed in to Dockhold. Run "npx dockhold login" in a terminal, then try again.');
  assert.equal(h.stderr.length, 1, "the reason is printed once, not per message");
});

test("a config without a saved host uses the default host with the saved token", async () => {
  const h = harness({ config: { ok: true, path: PATH, token: TOKEN, apiUrl: null } });
  await h.bridge.handleLine(line(toolCall));
  assert.equal(h.calls[0]!.url, DEFAULT_HOST + "/mcp");
  assert.equal(h.calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
});

test("announce prints the effective host and config path once", async () => {
  const h = harness();
  await h.bridge.announce();
  await h.bridge.handleLine(line(init));
  assert.equal(h.stderr.length, 1);
  assert.ok(h.stderr[0]!.includes(HOST) && h.stderr[0]!.includes(PATH));
  assert.ok(!h.stderr[0]!.includes(TOKEN));
});

test("a batch mixing a local answer and forwarded requests comes back as one array", async () => {
  const h = harness({ config: { ok: true, path: PATH, token: null, apiUrl: HOST } });
  const out = await h.bridge.handleLine(line([init, toolCall, initialized]));
  const arr = JSON.parse(out!) as Record<string, unknown>[];
  assert.equal(arr.length, 2);
  const ids = arr.map((r) => r.id).sort();
  assert.deepEqual(ids, [1, 3]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(h.calls[0]!.body), [init, initialized]);
});

test("runMcp: nothing but JSON-RPC lines on stdout across every case", async () => {
  const calls: Call[] = [];
  let n = 0;
  const handler: Handler = (c) => {
    n++;
    const parsed = JSON.parse(c.body) as { id?: number; method: string };
    if (parsed.method === "tools/list" && n === 3) return json(401, { error: "invalid token" });
    if (parsed.method === "ping") return json(200, { jsonrpc: "2.0", id: parsed.id, error: { code: -32029, message: "rate limit exceeded" } });
    if (parsed.method === "tools/call" && parsed.id === 4) return json(403, { error: "account suspended" });
    return echo(c, n);
  };
  const stderr: string[] = [];
  const deps: BridgeDeps = {
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      const call = { url, headers, body: String(init.body), init };
      calls.push(call);
      return handler(call, calls.length);
    },
    readConfig: async () => ({ ok: true, path: PATH, token: TOKEN, apiUrl: HOST }),
    stderr: (l) => stderr.push(l),
    env: {},
  };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let captured = "";
  stdout.on("data", (d) => (captured += String(d)));

  const done = runMcp({ stdin, stdout }, deps);
  const lines = [
    line(init),
    line(initialized),
    line(toolsList),
    "",
    "garbage",
    line({ jsonrpc: "2.0", id: 8, method: "ping" }),
    line({ ...toolCall, id: 4 }),
    line(toolCall),
    line([init, toolsList]),
  ];
  stdin.end(lines.join("\n") + "\n");
  assert.equal(await done, 0);

  const outLines = captured.split("\n").filter((l) => l.length > 0);
  assert.equal(outLines.length, 7, captured);
  const seen = new Set<string>();
  for (const l of outLines) {
    const v = JSON.parse(l) as Record<string, unknown> | Record<string, unknown>[];
    for (const r of Array.isArray(v) ? v : [v]) {
      assert.equal(r.jsonrpc, "2.0");
      assert.ok("id" in r);
      assert.ok("result" in r || "error" in r);
      seen.add(JSON.stringify(r.id));
    }
    assert.ok(!l.includes(TOKEN));
  }
  assert.deepEqual([...seen].sort(), ["1", "2", "3", "4", "8", "null"]);
  assert.ok(stderr.length >= 1 && stderr[0]!.startsWith("dockhold mcp: host " + HOST));
  assert.ok(!stderr.join("\n").includes(TOKEN));
});
