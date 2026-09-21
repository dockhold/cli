# dockhold

Put your app online straight from your computer, or from the AI tool you are
already working in. No GitHub, no Docker, no setup.

Point the CLI at a project folder and it uploads your code, builds it, and gives
you a live URL. If your project has a Dockerfile it uses that. If it does not,
Dockhold builds common stacks for you on every account: Next.js, Vite, Node,
static sites and FastAPI. Automatic builds for any other stack come with
compute added (from $5/month). A Dockerfile at the root of your folder always
works, on any account, and there are examples to copy at
https://dockhold.eu/docs/concepts/dockerfiles.

## Quickstart

```
npx dockhold login
npx dockhold deploy
```

`login` opens your browser once to connect your Dockhold account. `deploy` packs
the current folder, uploads it, and prints your app's URL when it is live. Run
`deploy` again any time to push a new version.

## Use from your AI tool

Claude Code, Cursor, VS Code, Codex and any other MCP client can drive Dockhold
through the same sign-in. Add this server to your client's MCP config:

```json
{
  "command": "npx",
  "args": ["-y", "dockhold", "mcp"]
}
```

Then ask the tool to put your project online. If you are not signed in yet,
the first call tells the tool to run `npx dockhold login`; do that once in a
terminal and try again, no restart needed.

Your access token never sits in an editor config file. `dockhold mcp` reads
the sign-in that `dockhold login` saved and talks to Dockhold on the client's
behalf. It ignores `DOCKHOLD_API_URL`, `DOCKHOLD_TOKEN`, `HOME` and
`XDG_CONFIG_HOME` on purpose: an MCP config inside a cloned repository can set
environment variables for the servers it declares, and honouring them there
would let a repository point the bridge at another host, or at another
account, with your sign-in. The host and the token come from your own config
file only, and the host must be https. It also refuses to send your sign-in
while `NODE_TLS_REJECT_UNAUTHORIZED=0` is set, since that turns certificate
checks off. What it cannot cover: the same config block can set `NODE_OPTIONS`
(which runs code before the bridge starts) or `NODE_EXTRA_CA_CERTS`, and the
command line itself; your client's approval prompt for a new server is the
place to look at those before saying yes.

`npx -y dockhold` downloads the package on first run. If your client gives a
server only a few seconds to start, install it once with `npm i -g dockhold`
and the first start is instant.

## Commands

```
dockhold login [--token [<token>]]      Sign in (a bare --token prompts for a
                                        paste, keeping it out of shell history)
dockhold deploy [--name <name>]         Deploy the current folder
               [--env KEY=VALUE ...]    Set an environment variable (repeatable)
               [--db]                   Add a managed database
dockhold logs [--app <id>]              Show recent logs
              [--tail <n>] [--type app|build|db]
dockhold list                           List your apps
dockhold open [--app <id>]              Open an app in your browser
dockhold mcp                            Serve MCP over stdio for an AI tool
```

## What gets uploaded

The CLI packs your project folder, with a few things always left out:

- `.git` and `node_modules`
- every `.env` file (see below)
- anything your `.gitignore` excludes

You can add a `.dockholdignore` file (same format as `.gitignore`) to exclude
more. It takes priority over `.gitignore`.

## How your folder gets built

The build picks its instructions in this order:

1. A `Dockerfile` at the root of the folder.
2. A `dockhold.json` at the root pointing at one:

```json
{
  "build": {
    "dockerfile": "docker/Dockerfile.prod"
  }
}
```

3. The stacks Dockhold recognises, on every account: Next.js (standalone
   output), Vite, Node with a `start` script, a static site, FastAPI. A stack
   it does not recognise is declined in seconds with the fix named.
4. Automatic builds for any stack (Node, Python, Go, Rust, Ruby, Deno, Bun,
   Java, PHP), on accounts with compute added.

If none of these apply, `deploy` says so before uploading anything, so nothing
is half-done while you go add a Dockerfile.

## Environment variables

Your `.env` files are never uploaded. Set variables on the deploy instead:

```
npx dockhold deploy --env DATABASE_URL=... --env API_KEY=...
```

You can also manage them in the dashboard. They are stored encrypted and injected
into your app at runtime.

## Configuration

The CLI talks to Dockhold's hosted service by default. These environment
variables override that for `login`, `deploy`, `logs`, `list` and `open`:

- `DOCKHOLD_TOKEN`: use this access token instead of the signed-in one
- `DOCKHOLD_API_URL`: point at a different API endpoint
- `DOCKHOLD_DASHBOARD_URL`: point sign-in at a different dashboard
- `DOCKHOLD_REF`: a short label (letters, digits, dashes) for where this
  sign-in came from; the default is `cli`

Your sign-in is stored in `~/.config/dockhold/config.json` with owner-only
permissions, together with the API host it belongs to. `login` saves the host
it signed in against; the other commands use `DOCKHOLD_API_URL` when it is
set, else that saved host, else the default, and tell you on stderr when they
are using a saved host that is not the default.

`~` here is the home directory the operating system reports for your user,
not `HOME` or `XDG_CONFIG_HOME`. The other commands fall back to `HOME` only
if the operating system has no record of your user; `dockhold mcp` never
does, and says so on stderr. `dockhold mcp` reads none of the variables above
except `DOCKHOLD_REF`.

## Requirements

Node.js 18.19 or newer.

## Changelog

### 0.2.0

- New `dockhold mcp` command: MCP over stdio for Claude Code, Cursor, VS Code,
  Codex and other AI tools, using the sign-in from `dockhold login`. No token
  in any editor config.
- The config file now stores the API host next to the token, and the other
  commands use that host unless `DOCKHOLD_API_URL` overrides it.
- The config file lives at `~/.config/dockhold/config.json` under the home
  directory the operating system reports. If you had set a custom
  `XDG_CONFIG_HOME`, sign in once more.
- `dockhold deploy` points you at `dockhold logs --type build` when a deploy
  fails.
- `dockhold login` sends a `ref` label with the sign-in (`DOCKHOLD_REF`, or
  `cli`).
- New apps created by `dockhold deploy` start at the smallest size. Resize
  them in the dashboard when they need more.
- The published 0.1.2 listed itself as a dependency; 0.2.0 does not.
