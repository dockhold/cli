// Test preload: makes os.userInfo() report DOCKHOLD_TEST_HOME as the home
// directory, so an end-to-end run of the built CLI reads a config file from a
// temp folder instead of the real one. The bridge ignores HOME on purpose, so
// a test cannot redirect it that way; this stands in for the operating
// system's answer. Loaded with `node --import ./test/helpers/stub-home.mjs`,
// never shipped (the npm package contains dist/ only).
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.DOCKHOLD_TEST_HOME;
if (home) {
  const real = os.userInfo.bind(os);
  os.userInfo = (options) => ({ ...real(options), homedir: home });
  syncBuiltinESMExports();
}
