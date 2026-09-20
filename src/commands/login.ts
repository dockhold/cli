// `dockhold login`: an exchange-code browser flow (RFC 8252 native-app
// shape), with a `--token` paste fallback.
//
// Security shape:
//   * the loopback server binds 127.0.0.1 ONLY and closes as soon as it has
//     served one VALID callback;
//   * a random `state` nonce is generated here and MUST match on the callback.
//     A mismatched or codeless callback gets a 400 and the server KEEPS
//     listening: any webpage open during login can probe loopback ports, and
//     letting a forged request kill the flow would deny real sign-ins (and push
//     users toward the weaker --token paste path). Only the timeout or a valid
//     callback ends the wait;
//   * the browser is handed back a single-use CODE, never a token. The token is
//     fetched by POSTing the code to /cli/auth/exchange, so no token ever travels
//     in a URL or lands in browser history;
//   * a ~5 min timeout bounds the wait;
//   * the token is never logged.
//
// The token is saved together with the API host it was exchanged at, so the
// other commands (and `dockhold mcp`) send it to the place that issued it.

import http from "node:http";
import readline from "node:readline";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import { dashboardUrl } from "../env.js";
import { apiBase, exchangeCode } from "../api.js";
import { saveConfig, validateTokenShape } from "../config.js";
import { openBrowser } from "../browser.js";
import { flagValue, hasFlag } from "../args.js";
import { refSlug } from "../ref.js";
import { err, info } from "../output.js";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// authorizeUrl is the dashboard page the browser opens. The `ref` slug tells
// the dashboard where the sign-in came from; see src/ref.ts.
export function authorizeUrl(
  dashboard: string,
  state: string,
  port: number,
  env: Record<string, string | undefined> = process.env,
): string {
  return `${dashboard}/cli-auth?state=${encodeURIComponent(state)}&port=${port}&ref=${refSlug(env)}`;
}

export interface LoginDeps {
  browserFlow: () => Promise<string>;
  exchangeCode: (code: string) => Promise<string>;
  apiBase: () => Promise<string>;
  saveConfig: (cfg: { token: string; apiUrl: string }) => Promise<string>;
  readTokenFromStdin: () => Promise<string>;
}

const defaultDeps: LoginDeps = { browserFlow, exchangeCode, apiBase, saveConfig, readTokenFromStdin };

export async function login(args: string[], deps: LoginDeps = defaultDeps): Promise<number> {
  if (hasFlag(args, "--token")) {
    // A bare `--token` reads the value from stdin, keeping it out of shell
    // history and the process list. `--token <value>` still works as the
    // documented fallback.
    const raw = flagValue(args, "--token") ?? (await deps.readTokenFromStdin());
    const token = raw.trim();
    const bad = validateTokenShape(token);
    if (bad) {
      err(bad);
      return 1;
    }
    await deps.saveConfig({ token, apiUrl: await deps.apiBase() });
    info("Saved your access token.");
    return 0;
  }

  let code: string;
  try {
    code = await deps.browserFlow();
  } catch (e) {
    err(`Sign-in did not complete: ${(e as Error).message}`);
    err("You can also paste a token: dockhold login --token <your token>");
    return 1;
  }

  try {
    // Resolve the host before the exchange so the saved host is exactly the
    // one the code was redeemed at.
    const apiUrl = await deps.apiBase();
    const token = await deps.exchangeCode(code);
    await deps.saveConfig({ token, apiUrl });
    info('You are signed in. Run "dockhold deploy" from your project folder.');
    return 0;
  } catch (e) {
    err(`Could not finish sign-in: ${(e as Error).message}`);
    return 1;
  }
}

// readTokenFromStdin prompts for and reads one line. Used by a bare `--token`
// so the secret never appears in argv.
function readTokenFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question("Paste your access token: ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// browserFlow starts the loopback listener, opens the dashboard authorize page,
// and resolves with the single-use code from the callback.
function browserFlow(): Promise<string> {
  const state = randomBytes(16).toString("hex");

  return new Promise<string>((resolve, reject) => {
    let timer: NodeJS.Timeout;

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      const gotState = reqUrl.searchParams.get("state") || "";
      const gotCode = reqUrl.searchParams.get("code") || "";
      if (gotState !== state || !gotCode) {
        // Not ours (or incomplete). Answer and keep waiting for the real one.
        res
          .writeHead(400, { "content-type": "text/plain" })
          .end("This sign-in request did not match. Close this tab and return to your terminal.");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(SUCCESS_PAGE);
      finish();
      resolve(gotCode);
    });

    function finish(): void {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    // Port 0 = OS picks a free ephemeral port; bind loopback only.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const authUrl = authorizeUrl(dashboardUrl(), state, port);
      info("Opening your browser to sign in.");
      info(`If it does not open, visit this link:\n  ${authUrl}`);
      openBrowser(authUrl);
      timer = setTimeout(() => {
        server.close();
        reject(new Error("timed out waiting for sign-in"));
      }, LOGIN_TIMEOUT_MS);
    });
  });
}

const SUCCESS_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Dockhold</title>' +
  '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">' +
  "<h2>You are signed in.</h2><p>You can close this tab and return to your terminal.</p></body>";
