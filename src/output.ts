// Plain human output. No emoji, no spinners, no color (local-deploy-spec D11 /
// root §2.3 — the terminal output is user-facing copy).

export function info(msg: string): void {
  process.stdout.write(msg + "\n");
}

export function err(msg: string): void {
  process.stderr.write(msg + "\n");
}
