import { spawn } from "node:child_process";

// openBrowser best-effort opens a URL in the user's default browser. It never
// throws — the caller always prints the URL too, so a headless box still works.
export function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* opener missing — the URL was printed */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}
