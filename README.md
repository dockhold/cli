# dockhold

Put your app online straight from your computer. No GitHub, no Docker, no setup.

Point the CLI at a project folder and it uploads your code, builds it, and gives
you a live URL. If your project has a Dockerfile it uses that. If it does not,
Dockhold detects your stack and builds it for you, on any account with compute
added (from $5/month). On a free account, add a Dockerfile at the root of your
folder: without one the deploy stops before it uploads and tells you what to
add. There are examples to copy at
https://dockhold.eu/docs/concepts/dockerfiles.

## Quickstart

```
npx dockhold login
npx dockhold deploy
```

`login` opens your browser once to connect your Dockhold account. `deploy` packs
the current folder, uploads it, and prints your app's URL when it is live. Run
`deploy` again any time to push a new version.

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

3. Automatic stack detection (Node, Python, Go, Rust, Ruby, Deno, Bun, Java,
   PHP), on accounts with compute added.

Free accounts stop at step 2. If neither file is there, `deploy` says so before
uploading anything, so nothing is half-done while you go add one.

## Environment variables

Your `.env` files are never uploaded. Set variables on the deploy instead:

```
npx dockhold deploy --env DATABASE_URL=... --env API_KEY=...
```

You can also manage them in the dashboard. They are stored encrypted and injected
into your app at runtime.

## Configuration

The CLI talks to Dockhold's hosted service by default. These environment
variables override that when you need to:

- `DOCKHOLD_TOKEN` — use this access token instead of the signed-in one
- `DOCKHOLD_API_URL` — point at a different API endpoint
- `DOCKHOLD_DASHBOARD_URL` — point sign-in at a different dashboard

Your access token is stored in `~/.config/dockhold/config.json` with owner-only
permissions.

## Requirements

Node.js 18 or newer.
