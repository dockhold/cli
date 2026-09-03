// Does this folder already say how to build itself?
//
// The build system picks what to build from, in this order: a `Dockerfile` at
// the project root, then a `dockhold.json` naming one under `build.dockerfile`,
// then automatic stack detection. That last step is a paid feature, so a free
// account whose folder answers neither of the first two has a deploy that
// cannot succeed. Checking here means the answer arrives before the upload
// instead of after a build that was never going to run.
//
// This mirrors the server's order deliberately. If the server ever gains a
// third way to declare a build, add it here too or the CLI will refuse a deploy
// that would have worked.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// hasOwnBuildFile is true when the folder ships its own build instructions.
// A `dockhold.json` that names a Dockerfile counts on its word: the path is
// resolved at build time, and a wrong one is a different failure with its own
// message.
export async function hasOwnBuildFile(cwd: string): Promise<boolean> {
  if (await isFile(join(cwd, "Dockerfile"))) return true;
  try {
    const parsed = JSON.parse(await readFile(join(cwd, "dockhold.json"), "utf8")) as {
      build?: { dockerfile?: unknown };
    };
    const named = parsed.build?.dockerfile;
    return typeof named === "string" && named.trim().length > 0;
  } catch {
    return false;
  }
}

// What a free account reads instead of a doomed upload. It states the fix
// first and the upgrade second, and it stays close to the wording the build
// system uses for the same situation so the two never read like different
// products.
export const NO_DOCKERFILE_MESSAGE = [
  "No Dockerfile found in this folder.",
  "",
  "Free accounts build from a Dockerfile. Add one to the root of your project",
  '(or point to it with "build": {"dockerfile": "path"} in dockhold.json)',
  "and run dockhold deploy again.",
  "",
  "Examples you can copy: https://dockhold.eu/docs/concepts/dockerfiles",
  "",
  "Prefer us to detect your stack and build it for you, with no Dockerfile?",
  "That is included from your first compute unit ($5), under Settings > Billing.",
].join("\n");
