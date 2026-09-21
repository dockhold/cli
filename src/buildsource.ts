// Does this folder already say how to build itself?
//
// The build system picks what to build from, in this order: a `Dockerfile` at
// the project root, then a `dockhold.json` naming one under `build.dockerfile`,
// then the stacks the platform recognises (every account), then automatic
// builds for any stack (sold with compute). The presign answer says which of
// the last two apply. When neither does, a free account whose folder answers
// neither of the first two has a deploy that cannot succeed, and checking here
// means the answer arrives before the upload instead of after a build that was
// never going to run.
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

// What the presign answer says about building without a Dockerfile. Both are
// capabilities the server reports, never a plan name, and `undefined` is an
// older server that does not say.
export interface BuildCapabilities {
  autoBuild?: boolean;
  autoBuildStacks?: boolean;
}

// refusesWithoutBuildFile decides whether a folder with no Dockerfile (and no
// dockhold.json naming one) is refused before the upload. Only a definite
// "no" on both counts refuses: the account cannot build any stack, and the
// platform does not detect stacks for everyone. Unknown is not a refusal; an
// older server gets the deploy it always got, and the build answers.
export function refusesWithoutBuildFile(caps: BuildCapabilities): boolean {
  return caps.autoBuild === false && caps.autoBuildStacks !== true;
}

// What the person reads when the build will pick the stack itself. One line,
// so the decline that may follow (seconds later, with the fix named) is not a
// surprise.
export const DETECTING_STACK_MESSAGE = "No Dockerfile found. The build will detect your stack.";

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
