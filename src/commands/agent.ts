// `it agent ...` — manage requesting agents (clients that ask for access).
import { loadCtx } from "../context.ts";
import { id, nowISO } from "../util/id.ts";
import { parseArgs, str } from "../util/args.ts";
import { randomToken, sha256 } from "../util/crypto.ts";
import { log, color } from "../util/log.ts";
import type { RequestingAgent } from "../types.ts";

export async function cmdAgent(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "add":
    case "create": return add(rest);
    case "ls":
    case "list": return list();
    case "rotate": return rotate(rest);
    case "disable": return setDisabled(rest, true);
    case "enable": return setDisabled(rest, false);
    default:
      log.info("usage: it agent <add|list|rotate|disable|enable>");
  }
}

async function add(rest: string[]): Promise<void> {
  const { _, flags } = parseArgs(rest);
  const name = _[0] || str(flags, "name");
  if (!name) { log.err("usage: it agent add <name> [--desc ...]"); process.exit(1); }
  const { store } = await loadCtx();
  if (store.agent(name)) { log.err(`agent "${name}" already exists`); process.exit(1); }

  const token = `mjd_${randomToken(24)}`;
  const agent: RequestingAgent = {
    id: id("agt"),
    name,
    description: str(flags, "desc") || undefined,
    tokenHash: sha256(token),
    tokenPrefix: token.slice(0, 12),
    disabled: false,
    createdAt: nowISO(),
    metadata: {},
  };
  store.addAgent(agent);
  store.audit("human", "agent.add", { agent: agent.id, name });

  log.ok(`created agent ${color.bold(name)} (${agent.id})`);
  log.info("");
  log.warn("bearer token — shown once, give it to the agent:");
  log.info(`\n    ${color.bold(color.cyan(token))}\n`);
  log.detail(`the agent presents this to request access:`);
  log.detail(`it request --as ${token.slice(0, 12)}… "I need a database"`);
}

async function list(): Promise<void> {
  const { store } = await loadCtx();
  const agents = store.agents();
  if (agents.length === 0) { log.info("no agents yet. try: it agent add my-bot"); return; }
  log.info(color.bold("\n  requesting agents:\n"));
  for (const a of agents) {
    const dot = a.disabled ? color.red("○") : color.green("●");
    const grants = store.grantsFor(a.id).length;
    log.info(`  ${dot} ${a.name.padEnd(16)} ${color.dim(a.id)}  token ${a.tokenPrefix}…  ${color.dim(`${grants} grant(s)`)}`);
    if (a.description) log.detail(a.description);
  }
  log.info("");
}

async function rotate(rest: string[]): Promise<void> {
  const { _ } = parseArgs(rest);
  const { store } = await loadCtx();
  const agent = store.agent(_[0] || "");
  if (!agent) { log.err(`agent "${_[0]}" not found`); process.exit(1); }
  const token = `mjd_${randomToken(24)}`;
  agent.tokenHash = sha256(token);
  agent.tokenPrefix = token.slice(0, 12);
  store.addAgent(agent);
  store.audit("human", "agent.rotate", { agent: agent.id });
  log.ok(`rotated token for ${agent.name}`);
  log.info(`\n    ${color.bold(color.cyan(token))}\n`);
}

async function setDisabled(rest: string[], disabled: boolean): Promise<void> {
  const { _ } = parseArgs(rest);
  const { store } = await loadCtx();
  const agent = store.agent(_[0] || "");
  if (!agent) { log.err(`agent "${_[0]}" not found`); process.exit(1); }
  agent.disabled = disabled;
  store.addAgent(agent);
  store.audit("human", disabled ? "agent.disable" : "agent.enable", { agent: agent.id });
  log.ok(`${disabled ? "disabled" : "enabled"} ${agent.name}`);
}
