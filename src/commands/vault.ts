// `majordomo vault ...` — inspect the encrypted secret store (values shown only with --reveal).
import { loadCtx } from "../context.ts";
import { parseArgs, bool } from "../util/args.ts";
import { log, color } from "../util/log.ts";

export async function cmdVault(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "ls":
    case "list": return list(rest);
    case "get": return get(rest);
    default:
      log.info("usage: majordomo vault <list|get> [--reveal]");
  }
}

async function list(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const reveal = bool(flags, "reveal");
  const { vault } = await loadCtx();
  const items = vault.list();
  if (items.length === 0) { log.info("vault is empty"); return; }
  log.info(color.bold("\n  vault:\n"));
  for (const it of items) {
    const val = reveal ? vault.get(it.ref) ?? "" : "••••••••";
    log.info(`  ${color.dim(it.ref)}  ${it.name.padEnd(28)} ${color.dim(val)}`);
  }
  log.info("");
}

async function get(rest: string[]): Promise<void> {
  const { _ } = parseArgs(rest);
  const { vault } = await loadCtx();
  const v = vault.get(_[0] || "");
  if (v === undefined) { log.err(`no secret ${_[0]}`); process.exit(1); }
  process.stdout.write(v + "\n");
}
