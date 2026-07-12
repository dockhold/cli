// Plain human output. No emoji, no spinners, no color — the terminal output is
// user-facing copy and should read like a person wrote it.

export function info(msg: string): void {
  process.stdout.write(msg + "\n");
}

export function err(msg: string): void {
  process.stderr.write(msg + "\n");
}
