// `it policy ...` — configure which agents may do what on which services.
import { loadCtx } from "../context.ts";
import { id, nowISO } from "../util/id.ts";
import { parseArgs, str, num, bool } from "../util/args.ts";
import { catalogEntry } from "../catalog.ts";
import { log, color } from "../util/log.ts";
import type { Policy, PolicyAction } from "../types.ts";

const VALID_ACTIONS = ["read", "provision", "signup", "*"];

export async function cmdPolicy(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "allow":
    case "add": return allow(rest);
    case "ls":
    case "list": return list();
    case "rm":
    case "remove": return remove(rest);
    default:
      log.info("usage: it policy <allow|list|remove>");
      log.detail('e.g. it policy allow my-bot supabase provision --max 3');
      log.detail('     it policy allow "*" twilio read');
  }
}

async function allow(rest: string[]): Promise<void> {
  const { _, flags } = parseArgs(rest);
  const [agentRef, serviceKey, ...actions] = _;
  if (!agentRef || !serviceKey) {
    log.err('usage: it policy allow <agent|*> <service|*> [actions...] [--max N] [--approve]');
    process.exit(1);
  }
  const { store } = await loadCtx();

  let agentId = "*";
  if (agentRef !== "*") {
    const agent = store.agent(agentRef);
    if (!agent) { log.err(`agent "${agentRef}" not found`); process.exit(1); }
    agentId = agent.id;
  }
  if (serviceKey !== "*" && !catalogEntry(serviceKey)) {
    log.err(`unknown service "${serviceKey}"`); process.exit(1);
  }
  const acts = (actions.length ? actions : ["provision"]).map((a) => a.toLowerCase());
  for (const a of acts) if (!VALID_ACTIONS.includes(a)) { log.err(`invalid action "${a}" (valid: ${VALID_ACTIONS.join(", ")})`); process.exit(1); }

  const policy: Policy = {
    id: id("pol"),
    agentId,
    serviceKey,
    actions: acts as PolicyAction[],
    maxGrants: num(flags, "max", 0),
    requiresApproval: bool(flags, "approve"),
    createdAt: nowISO(),
  };
  store.addPolicy(policy);
  store.audit("human", "policy.add", { policy: policy.id, agentId, serviceKey, actions: acts });
  log.ok(`policy ${policy.id}: ${agentRef} → ${serviceKey} [${acts.join(",")}]${policy.maxGrants ? ` max=${policy.maxGrants}` : ""}${policy.requiresApproval ? " (needs approval)" : ""}`);
}

async function list(): Promise<void> {
  const { store } = await loadCtx();
  const pols = store.policies();
  if (pols.length === 0) { log.info("no policies. try: it policy allow my-bot supabase provision"); return; }
  log.info(color.bold("\n  policies:\n"));
  for (const p of pols) {
    const agentName = p.agentId === "*" ? "*" : store.agents().find((a) => a.id === p.agentId)?.name ?? p.agentId;
    const extras = [p.maxGrants ? `max=${p.maxGrants}` : "", p.requiresApproval ? "approval" : ""].filter(Boolean).join(" ");
    log.info(`  ${color.dim(p.id)}  ${color.cyan(String(agentName).padEnd(14))} → ${p.serviceKey.padEnd(12)} [${p.actions.join(",")}] ${color.dim(extras)}`);
  }
  log.info("");
}

async function remove(rest: string[]): Promise<void> {
  const { _ } = parseArgs(rest);
  const { store } = await loadCtx();
  if (!_[0]) { log.err("usage: it policy remove <policy-id>"); process.exit(1); }
  const ok = store.removePolicy(_[0]);
  if (ok) { store.audit("human", "policy.remove", { policy: _[0] }); log.ok(`removed ${_[0]}`); }
  else log.err(`policy ${_[0]} not found`);
}
