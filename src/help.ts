// Per-command usage and the argument guard every command runs first.
//
// `-h` / `--help` anywhere in the arguments prints usage and exits 0, and an
// unknown flag is refused. Both happen before a command reads its token, makes
// a network call, packs files or opens a browser, so asking for help can never
// change anything.

import { err, info } from "./output.js";

export type CommandName = "login" | "deploy" | "logs" | "list" | "open" | "mcp";

interface CommandFlags {
  usage: string;
  // Flags that take a value. A bare `--token` is allowed (it prompts), so a
  // value is optional for every flag here except --env.
  valueFlags: string[];
  boolFlags: string[];
}

const FLAGS: Record<CommandName, CommandFlags> = {
  login: {
    usage: `Usage: dockhold login [--token [<token>]]

Sign in. With no flag, opens your browser to finish sign-in.
  --token [<token>]   Paste an access token instead. A bare --token prompts for it.
`,
    valueFlags: ["--token"],
    boolFlags: [],
  },
  deploy: {
    usage: `Usage: dockhold deploy [--name <name>] [--env KEY=VALUE ...] [--db]

Deploy the current folder. The first deploy creates the app.
  --name <name>       Name for a new app (default: the folder name)
  --env KEY=VALUE     Set an environment variable on a new app (repeatable)
  --db                Add a managed database to a new app
`,
    valueFlags: ["--name", "--env"],
    boolFlags: ["--db"],
  },
  logs: {
    usage: `Usage: dockhold logs [--app <id>] [--tail <n>] [--type app|build|db]

Show recent logs for the app in this folder.
  --app <id>          Use this app instead of the one in this folder
  --tail <n>          Number of lines (default 100)
  --type app|build|db Which logs to show (default app)
`,
    valueFlags: ["--app", "--tail", "--type"],
    boolFlags: [],
  },
  list: {
    usage: `Usage: dockhold list

List your apps with their status and address.
`,
    valueFlags: [],
    boolFlags: [],
  },
  open: {
    usage: `Usage: dockhold open [--app <id>]

Open an app in your browser.
  --app <id>          Use this app instead of the one in this folder
`,
    valueFlags: ["--app"],
    boolFlags: [],
  },
  mcp: {
    usage: `Usage: dockhold mcp

Run the MCP bridge over stdio, for AI tools. See the README for setup.
`,
    valueFlags: [],
    boolFlags: [],
  },
};

export function usage(cmd: CommandName): string {
  return FLAGS[cmd].usage;
}

// firstUnknownFlag returns the first dash-led argument that is neither a flag
// this command documents nor the value of one. Plain words are left alone, as
// they always were.
export function firstUnknownFlag(cmd: CommandName, args: string[]): string | null {
  const flags = FLAGS[cmd];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-") || a === "-") continue;
    if (flags.boolFlags.includes(a)) continue;
    if (flags.valueFlags.includes(a)) {
      // Same consumption rules as flagValue / envFlags in args.ts.
      const next = args[i + 1];
      if (a === "--env" || (next !== undefined && !next.startsWith("--"))) i++;
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0 && flags.valueFlags.includes(a.slice(0, eq))) continue;
    return a;
  }
  return null;
}

// guardArgs returns an exit code when the command must stop here (help was
// asked for, or a flag is unknown), and null to carry on.
export function guardArgs(cmd: CommandName, args: string[]): number | null {
  if (args.includes("--help") || args.includes("-h")) {
    info(usage(cmd).trimEnd());
    return 0;
  }
  const bad = firstUnknownFlag(cmd, args);
  if (bad) {
    err(`Unknown option: ${bad}. Run "dockhold ${cmd} --help" to see what is supported.`);
    return 2;
  }
  return null;
}
