import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeUrl, login, type LoginDeps } from "../src/commands/login.js";
import { refSlug } from "../src/ref.js";
import { readConfigChecked, saveConfig } from "../src/config.js";
import { createBridge } from "../src/commands/mcp.js";

const TOKEN = "dh_mcp_login_" + "t".repeat(24);

function deps(overrides: Partial<LoginDeps> = {}): LoginDeps & { saved: { token: string; apiUrl: string }[] } {
  const saved: { token: string; apiUrl: string }[] = [];
  return {
    saved,
    browserFlow: async () => "code-123",
    exchangeCode: async () => TOKEN,
    apiBase: async () => "https://api.example.test",
    saveConfig: async (cfg) => {
      saved.push(cfg);
      return "/tmp/config.json";
    },
    readTokenFromStdin: async () => TOKEN,
    ...overrides,
  };
}

test("the sign-in link carries ref=cli by default", () => {
  assert.equal(authorizeUrl("https://app.example", "abc", 4321, {}), "https://app.example/cli-auth?state=abc&port=4321&ref=cli");
});

test("a valid DOCKHOLD_REF replaces the default; an invalid one is dropped, never sent", () => {
  assert.equal(refSlug({ DOCKHOLD_REF: "claude-plugin" }), "claude-plugin");
  assert.equal(authorizeUrl("https://app.example", "s", 1, { DOCKHOLD_REF: "cursor" }), "https://app.example/cli-auth?state=s&port=1&ref=cursor");
  for (const bad of ["Cursor", "with space", "x".repeat(33), "a&b=c", "../../x", "", "über"]) {
    assert.equal(refSlug({ DOCKHOLD_REF: bad }), "cli", JSON.stringify(bad));
    const url = authorizeUrl("https://app.example", "s", 1, { DOCKHOLD_REF: bad });
    assert.ok(url.endsWith("&ref=cli"), url);
    assert.ok(bad === "" || !url.includes(bad));
  }
});

test("browser login saves the token together with the API host it was exchanged at", async () => {
  const d = deps();
  assert.equal(await login([], d), 0);
  assert.deepEqual(d.saved, [{ token: TOKEN, apiUrl: "https://api.example.test" }]);
});

test("token paste login saves the resolved API host next to the token", async () => {
  const d = deps({ apiBase: async () => "https://dev.example" });
  assert.equal(await login(["--token", TOKEN], d), 0);
  assert.deepEqual(d.saved, [{ token: TOKEN, apiUrl: "https://dev.example" }]);
});

test("a login against one host makes a later mcp session talk to that host", async () => {
  const home = await mkdtemp(join(tmpdir(), "dockhold-login-"));
  try {
    const d = deps({
      apiBase: async () => "https://dev.example",
      saveConfig: (cfg) => saveConfig(cfg, home),
    });
    assert.equal(await login([], d), 0);

    const calls: { url: string; auth: string | undefined }[] = [];
    const bridge = createBridge({
      fetch: async (url, init) => {
        calls.push({ url, auth: (init.headers as Record<string, string>).authorization });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 });
      },
      readConfig: () => readConfigChecked({ homedir: () => home }),
      stderr: () => {},
      env: { DOCKHOLD_API_URL: "https://ignored.example" },
    });
    await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_apps" } }));
    assert.deepEqual(calls, [{ url: "https://dev.example/mcp", auth: `Bearer ${TOKEN}` }]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
