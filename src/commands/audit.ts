// `majordomo audit` / `grants` — review what the IT agent has done.
import { loadCtx } from "../context.ts";
import { parseArgs, num } from "../util/args.ts";
import { log, color } from "../util/log.ts";

export async function cmdAudit(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const limit = num(flags, "n", 30);
  const { store } = await loadCtx();
  const entries = store.auditLog().slice(0, limit);
  if (entries.length === 0) { log.info("no audit entries yet"); return; }
  log.info(color.bold("\n  audit log:\n"));
  for (const e of entries) {
    const when = e.at.replace("T", " ").slice(0, 19);
    log.info(`  ${color.dim(when)}  ${color.cyan(e.actor.padEnd(12))} ${color.bold(e.event.padEnd(20))} ${color.dim(JSON.stringify(e.detail))}`);
  }
  log.info("");
}

export async function cmdGrants(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const { store } = await loadCtx();
  let grants = store.grants();
  if (flags["agent"]) {
    const a = store.agent(String(flags["agent"]));
    grants = grants.filter((g) => g.agentId === a?.id);
  }
  if (grants.length === 0) { log.info("no grants issued yet"); return; }
  log.info(color.bold("\n  grants:\n"));
  for (const g of grants) {
    const agentName = store.agents().find((a) => a.id === g.agentId)?.name ?? g.agentId;
    const dot = g.status === "active" ? color.green("●") : g.status === "revoked" ? color.red("○") : color.yellow("◐");
    log.info(`  ${dot} ${color.dim(g.id)}  ${String(agentName).padEnd(14)} ${g.serviceKey}/${g.action}  ${color.dim(g.status)}`);
    log.detail(JSON.stringify(g.resource));
  }
  log.info("");
}

export async function cmdRevoke(argv: string[]): Promise<void> {
  const { _ } = parseArgs(argv);
  const { store } = await loadCtx();
  const g = store.grant(_[0] || "");
  if (!g) { log.err(`grant ${_[0]} not found`); process.exit(1); }
  g.status = "revoked";
  g.revokedAt = new Date().toISOString();
  store.addGrant(g);
  store.audit("human", "grant.revoke", { grant: g.id });
  log.ok(`revoked ${g.id}`);
}
