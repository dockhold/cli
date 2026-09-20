#!/usr/bin/env node
import { login } from "./commands/login.js";
import { deploy } from "./commands/deploy.js";
import { logs } from "./commands/logs.js";
import { list } from "./commands/list.js";
import { open } from "./commands/open.js";
import { mcp } from "./commands/mcp.js";
import { info } from "./output.js";

const HELP = `dockhold: put your app online from your computer

Usage:
  dockhold login [--token [<token>]]   (a bare --token prompts for a paste)
  dockhold deploy [--name <name>] [--env KEY=VALUE ...] [--db]
  dockhold logs [--app <id>] [--tail <n>] [--type app|build|db]
  dockhold list
  dockhold open [--app <id>]
  dockhold mcp                          (for AI tools: MCP over stdio, see README)

Environment (login, deploy, logs, list, open):
  DOCKHOLD_TOKEN          use this access token instead of the saved one
  DOCKHOLD_API_URL        override the API endpoint (default https://api.dockhold.eu)
  DOCKHOLD_DASHBOARD_URL  override the sign-in URL (default https://app.dockhold.eu)
  DOCKHOLD_REF            a short label for where this sign-in came from

"dockhold mcp" reads none of these except DOCKHOLD_REF. It uses the host and
token saved by "dockhold login" in ~/.config/dockhold/config.json only.
`;

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "login":
      return login(args);
    case "deploy":
      return deploy(args);
    case "logs":
      return logs(args);
    case "list":
      return list();
    case "open":
      return open(args);
    case "mcp":
      return mcp();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      info(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`Unexpected error: ${e?.message ?? e}\n`);
    process.exit(1);
  });
