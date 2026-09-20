import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_API_URL, dashboardUrl, hostNotice, resolveApiUrl } from "../src/env.js";

test("interactive host order: environment, then the saved host, then the default", () => {
  assert.deepEqual(resolveApiUrl({ DOCKHOLD_API_URL: "https://dev.example/" }, "https://saved.example"), {
    url: "https://dev.example",
    source: "env",
  });
  assert.deepEqual(resolveApiUrl({}, "https://saved.example/"), { url: "https://saved.example", source: "saved" });
  assert.deepEqual(resolveApiUrl({ DOCKHOLD_API_URL: "  " }, null), { url: DEFAULT_API_URL, source: "default" });
  assert.deepEqual(resolveApiUrl({}, undefined), { url: DEFAULT_API_URL, source: "default" });
});

test("a saved host that is not the default is announced; the default and an env host are not", () => {
  assert.equal(hostNotice(resolveApiUrl({}, "https://saved.example")), "Using API host https://saved.example");
  assert.equal(hostNotice(resolveApiUrl({}, DEFAULT_API_URL)), null);
  assert.equal(hostNotice(resolveApiUrl({}, null)), null);
  assert.equal(hostNotice(resolveApiUrl({ DOCKHOLD_API_URL: "https://dev.example" }, null)), null);
});

test("dashboard URL comes from the environment or the default", () => {
  assert.equal(dashboardUrl({}), "https://app.dockhold.eu");
  assert.equal(dashboardUrl({ DOCKHOLD_DASHBOARD_URL: "https://dash.example//" }), "https://dash.example");
});
