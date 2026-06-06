// `majordomo service ...` — register and inspect services the org manages.
import { loadCtx } from "../context.ts";
import { CATALOG, catalogEntry } from "../catalog.ts";
import { id, nowISO } from "../util/id.ts";
import { parseArgs, str } from "../util/args.ts";
import { ask } from "../util/prompt.ts";
import { isSimulate } from "../config.ts";
import { log, color } from "../util/log.ts";
import type { ServiceInstance } from "../types.ts";

export async function cmdService(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "add": return add(rest);
    case "ls":
    case "list": return list();
    case "show": return show(rest);
    case "catalog": return catalog();
    case "set-secret": return setSecret(rest);
    default:
      log.info("usage: majordomo service <add|list|show|catalog|set-secret>");
  }
}

function catalog(): void {
  log.info(color.bold("\n  available services:\n"));
  for (const e of Object.values(CATALOG)) {
    log.info(`  ${color.cyan(e.key.padEnd(14))} ${e.displayName}  ${color.dim(`[${e.mode}]`)}`);
    log.detail(`${e.capabilities.map((c) => c.action).join(", ")}`);
  }
  log.info("");
}

async function add(rest: string[]): Promise<void> {
  const { _, flags } = parseArgs(rest);
  const key = (_[0] || str(flags, "key")).toLowerCase();
  if (!key) { log.err("usage: majordomo service add <name> [--signup-url ...] [--api-base ...] [--docs ...] [--secrets a,b]"); process.exit(1); }
  const entry = catalogEntry(key);
  const { store, vault } = await loadCtx();

  if (store.service(key)) {
    log.warn(`${key} already registered`);
    return;
  }

  // A service is either a catalog preset OR free-form (any name + URLs). The
  // universal agentic connector handles both, so no per-service code is needed.
  const displayName = entry?.displayName ?? (str(flags, "name") || key.replace(/\b\w/g, (c) => c.toUpperCase()));
  const signupUrl = str(flags, "signup-url") || entry?.signupUrl;
  const apiBase = str(flags, "api-base") || undefined;
  const docsUrl = str(flags, "docs") || entry?.docsUrl;
  const homepage = str(flags, "homepage") || entry?.homepage || (signupUrl ? new URL(signupUrl).origin : undefined);
  const adhoc = !entry;

  // Root secret names: catalog presets define them; ad-hoc uses --secrets or a default of "api_key".
  const secretDefs = entry
    ? entry.rootSecrets
    : (str(flags, "secrets") ? str(flags, "secrets").split(",") : ["api_key"]).map((n) => ({ name: n.trim(), label: n.trim(), help: `${displayName} ${n.trim()}` }));

  const rootSecretRefs: Record<string, string> = {};
  let haveAll = secretDefs.length > 0;
  for (const sec of secretDefs) {
    let val = str(flags, sec.name);
    if (!val && !flags["defer"] && process.stdin.isTTY) {
      if (sec.help) log.detail(sec.help);
      val = await ask(`${displayName} ${sec.label} (blank to skip / let the agent sign up later)`);
    }
    if (val) rootSecretRefs[sec.name] = vault.put(`${key}:${sec.name}`, val);
    else haveAll = false;
  }

  const svc: ServiceInstance = {
    id: id("svc"),
    catalogKey: key,
    displayName,
    status: haveAll ? "configured" : "needs-signup",
    mode: entry?.mode ?? "api",
    rootSecretRefs,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    metadata: {},
    adhoc,
    signupUrl,
    apiBase,
    docsUrl,
    homepage,
    capabilities: entry?.capabilities,
    rootSecretNames: secretDefs.map((s) => s.name),
  };
  store.addService(svc);
  store.audit("human", "service.add", { service: key, status: svc.status, adhoc });

  log.ok(`registered ${color.bold(displayName)} (${svc.id})${adhoc ? color.dim(" [free-form → universal connector]") : ""}`);
  if (haveAll) {
    log.detail("status: configured — ready to provision");
  } else {
    log.warn(`status: needs-signup — missing root secrets: ${secretDefs.filter((s) => !rootSecretRefs[s.name]).map((s) => s.name).join(", ") || "(none)"}`);
    log.detail(`the IT agent will sign up at ${signupUrl ?? homepage ?? "the service"} on first request${isSimulate() ? " (simulate mode)" : ""}`);
    log.detail(`or add a key now: majordomo service set-secret ${key} <name> <value>`);
  }
}

async function setSecret(rest: string[]): Promise<void> {
  const { _ } = parseArgs(rest);
  const [key, name, value] = _;
  if (!key || !name || !value) {
    log.err("usage: majordomo service set-secret <service> <name> <value>");
    process.exit(1);
  }
  const { store, vault } = await loadCtx();
  const svc = store.service(key);
  if (!svc) { log.err(`service "${key}" not registered`); process.exit(1); }
  svc.rootSecretRefs[name] = vault.put(`${svc.catalogKey}:${name}`, value);
  const needed = svc.rootSecretNames ?? catalogEntry(svc.catalogKey)?.rootSecrets.map((s) => s.name) ?? [name];
  const haveAll = needed.every((n) => svc.rootSecretRefs[n]);
  svc.status = haveAll ? "configured" : "needs-signup";
  svc.updatedAt = nowISO();
  store.addService(svc);
  store.audit("human", "service.set-secret", { service: key, name });
  log.ok(`set ${name} on ${svc.displayName} — status: ${svc.status}`);
}

async function list(): Promise<void> {
  const { store } = await loadCtx();
  const svcs = store.services();
  if (svcs.length === 0) { log.info("no services registered. try: majordomo service add supabase"); return; }
  log.info(color.bold("\n  services:\n"));
  for (const s of svcs) {
    const dot = s.status === "configured" || s.status === "active" ? color.green("●") : color.yellow("○");
    log.info(`  ${dot} ${s.displayName.padEnd(14)} ${color.dim(s.id)}  ${statusColor(s.status)}  ${color.dim(`[${s.mode}]`)}`);
  }
  log.info("");
}

function statusColor(s: string): string {
  if (s === "configured" || s === "active") return color.green(s);
  if (s === "error") return color.red(s);
  return color.yellow(s);
}

async function show(rest: string[]): Promise<void> {
  const { store } = await loadCtx();
  const svc = store.service(rest[0] || "");
  if (!svc) { log.err(`service "${rest[0]}" not found`); process.exit(1); }
  const entry = catalogEntry(svc.catalogKey);
  const caps = svc.capabilities ?? entry?.capabilities ?? [];
  log.info(color.bold(`\n  ${svc.displayName}  ${color.dim(svc.id)}\n`));
  log.detail(`status:  ${svc.status}${svc.adhoc ? "  (free-form → universal connector)" : ""}`);
  log.detail(`mode:    ${svc.mode}`);
  if (svc.signupUrl) log.detail(`signup:  ${svc.signupUrl}`);
  if (svc.apiBase) log.detail(`api:     ${svc.apiBase}`);
  if (svc.docsUrl) log.detail(`docs:    ${svc.docsUrl}`);
  log.detail(`secrets: ${Object.keys(svc.rootSecretRefs).join(", ") || "(none)"}`);
  if (svc.account) log.detail(`account: ${JSON.stringify(svc.account)}`);
  if (caps.length) {
    log.info(color.bold("\n  capabilities:"));
    for (const c of caps) log.detail(`${c.action} — ${c.title}`);
  } else {
    log.detail("\ncapabilities: open-ended (the agent provisions whatever is requested)");
  }
  log.info("");
}
