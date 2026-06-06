// Tiny color logger (no deps). Honors NO_COLOR.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const color = {
  dim: c("2"),
  bold: c("1"),
  red: c("31"),
  green: c("32"),
  yellow: c("33"),
  blue: c("34"),
  magenta: c("35"),
  cyan: c("36"),
};

export const log = {
  info: (...a: unknown[]) => console.log(...a),
  ok: (msg: string) => console.log(`${color.green("✓")} ${msg}`),
  warn: (msg: string) => console.log(`${color.yellow("!")} ${msg}`),
  err: (msg: string) => console.error(`${color.red("✗")} ${msg}`),
  step: (msg: string) => console.log(`${color.cyan("→")} ${msg}`),
  detail: (msg: string) => console.log(`  ${color.dim(msg)}`),
};

export function fail(msg: string): never {
  log.err(msg);
  process.exit(1);
}
