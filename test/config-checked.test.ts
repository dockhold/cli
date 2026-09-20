import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPathFor, loadConfig, readConfigChecked, saveConfig } from "../src/config.js";
import { createBridge, type BridgeDeps } from "../src/commands/mcp.js";

const TOKEN = "dh_mcp_checked_" + "q".repeat(24);
const posix = process.platform !== "win32";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dockhold-home-"));
}

// plant writes a config file under `home` with the given modes, the way an
// attacker (or a careless copy) might, bypassing saveConfig.
async function plant(home: string, body: unknown, fileMode: number, dirMode: number): Promise<string> {
  const path = configPathFor(home);
  await mkdir(join(home, ".config", "dockhold"), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(body), { mode: 0o600 });
  await chmod(path, fileMode);
  await chmod(join(home, ".config", "dockhold"), dirMode);
  return path;
}

test("saveConfig writes token and host together, 0600 in a 0700 folder, and readConfigChecked accepts it", async () => {
  const home = await tempHome();
  try {
    const path = await saveConfig({ token: TOKEN, apiUrl: "https://api.example.test/" }, home);
    assert.equal(path, configPathFor(home));
    if (posix) {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(home, ".config", "dockhold"))).mode & 0o777, 0o700);
    }
    const read = await readConfigChecked({ homedir: () => home });
    assert.deepEqual(read, { ok: true, path, token: TOKEN, apiUrl: "https://api.example.test" });
    assert.deepEqual(await loadConfig(home), { token: TOKEN, apiUrl: "https://api.example.test" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a missing config file is 'not signed in', not an error", async () => {
  const home = await tempHome();
  try {
    const read = await readConfigChecked({ homedir: () => home });
    assert.deepEqual(read, { ok: true, path: configPathFor(home), token: null, apiUrl: null });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a 0.1.x config with only a token still reads; the host is simply unset", async () => {
  const home = await tempHome();
  try {
    await plant(home, { token: TOKEN }, 0o600, 0o700);
    const read = await readConfigChecked({ homedir: () => home });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.token, TOKEN);
      assert.equal(read.apiUrl, null);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a 0644 config file is treated as no config, with the reason", { skip: !posix }, async () => {
  const home = await tempHome();
  try {
    const path = await plant(home, { token: TOKEN, apiUrl: "https://api.example.test" }, 0o644, 0o700);
    const read = await readConfigChecked({ homedir: () => home });
    assert.equal(read.ok, false);
    if (!read.ok) {
      assert.equal(read.path, path);
      assert.match(read.reason, /mode 644, expected 600/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a config file in a 0755 folder is treated as no config, with the reason", { skip: !posix }, async () => {
  const home = await tempHome();
  try {
    const path = await plant(home, { token: TOKEN, apiUrl: "https://api.example.test" }, 0o600, 0o755);
    const read = await readConfigChecked({ homedir: () => home });
    assert.equal(read.ok, false);
    if (!read.ok) {
      assert.equal(read.path, path);
      assert.match(read.reason, /mode 755, expected 700/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a config file owned by someone else is treated as no config", async () => {
  const home = await tempHome();
  try {
    await plant(home, { token: TOKEN }, 0o600, 0o700);
    // Pretend to be a different uid; the file's real owner is us.
    const read = await readConfigChecked({ homedir: () => home, platform: "linux", uid: () => 424242 });
    assert.equal(read.ok, false);
    if (!read.ok) assert.match(read.reason, /not owned by you/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the mode and owner checks are skipped on Windows", async () => {
  const home = await tempHome();
  try {
    await plant(home, { token: TOKEN }, 0o644, 0o755);
    const read = await readConfigChecked({ homedir: () => home, platform: "win32", uid: () => undefined });
    assert.equal(read.ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a file that is not valid JSON is treated as no config", async () => {
  const home = await tempHome();
  try {
    const path = configPathFor(home);
    await mkdir(join(home, ".config", "dockhold"), { recursive: true, mode: 0o700 });
    await writeFile(path, "{oops", { mode: 0o600 });
    const read = await readConfigChecked({ homedir: () => home });
    assert.equal(read.ok, false);
    if (!read.ok) assert.match(read.reason, /not valid JSON/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an unknown home directory is reported, not thrown", async () => {
  const read = await readConfigChecked({
    homedir: () => {
      throw new Error("no passwd entry");
    },
  });
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.path, null);
    assert.match(read.reason, /home directory/);
  }
});

test("HOME and XDG_CONFIG_HOME are ignored: the config comes from the OS home", async () => {
  const osHome = await tempHome();
  const envHome = await tempHome();
  const xdg = await tempHome();
  const savedEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  try {
    // A valid-looking config under the env-controlled locations, as a repo's
    // MCP config could arrange by setting HOME or XDG_CONFIG_HOME.
    await plant(envHome, { token: "dh_mcp_planted_" + "p".repeat(24), apiUrl: "https://api.example.test" }, 0o600, 0o700);
    await mkdir(join(xdg, "dockhold"), { recursive: true, mode: 0o700 });
    await writeFile(join(xdg, "dockhold", "config.json"), JSON.stringify({ token: "dh_mcp_planted_" + "x".repeat(24) }), { mode: 0o600 });
    process.env.HOME = envHome;
    process.env.XDG_CONFIG_HOME = xdg;

    // Nothing under the OS home: the bridge must see "not signed in".
    const read = await readConfigChecked({ homedir: () => osHome });
    assert.deepEqual(read, { ok: true, path: configPathFor(osHome), token: null, apiUrl: null });

    // And through the bridge: a tool call is refused without any request.
    const calls: string[] = [];
    const deps: BridgeDeps = {
      fetch: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 });
      },
      readConfig: () => readConfigChecked({ homedir: () => osHome }),
      stderr: () => {},
      env: {},
    };
    const bridge = createBridge(deps);
    const out = await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_apps" } }));
    assert.match(out!, /Not signed in to Dockhold/);
    assert.equal(calls.length, 0);
  } finally {
    process.env.HOME = savedEnv.HOME;
    if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
    await rm(osHome, { recursive: true, force: true });
    await rm(envHome, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

test("a bad-permission config through the bridge: anonymous introspection, not-signed-in tool calls, path on stderr", { skip: !posix }, async () => {
  const home = await tempHome();
  try {
    const path = await plant(home, { token: TOKEN, apiUrl: "https://api.example.test" }, 0o644, 0o700);
    const calls: { url: string; auth: string | undefined }[] = [];
    const stderr: string[] = [];
    const deps: BridgeDeps = {
      fetch: async (url, init) => {
        calls.push({ url, auth: (init.headers as Record<string, string>).authorization });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), { status: 200 });
      },
      readConfig: () => readConfigChecked({ homedir: () => home }),
      stderr: (l) => stderr.push(l),
      env: {},
    };
    const bridge = createBridge(deps);
    await bridge.announce();
    assert.ok(stderr[0]!.includes(path) && /mode 644/.test(stderr[0]!), stderr[0]);
    assert.ok(!stderr[0]!.includes(TOKEN));

    const a = await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    assert.ok(a && JSON.parse(a).result);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.dockhold.eu/mcp");
    assert.equal(calls[0]!.auth, undefined);

    const b = await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_apps" } }));
    assert.match(b!, /Not signed in to Dockhold/);
    assert.equal(calls.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
