#!/usr/bin/env node
// majordomo — IT manager agent harness. CLI router.
import { color, log } from "./util/log.ts";

const VERSION = "0.1.0";
const BIN = "it";

const HELP = `${color.bold(BIN)} ${color.dim("v" + VERSION)} — an IT-manager agent that provisions and grants service access to other agents.

${color.bold("setup (human):")}
  ${BIN} init                         initialize org + encrypted vault
  ${BIN} service catalog              list services it can manage
  ${BIN} service add <key>            register a service (e.g. supabase, twilio, browserbase)
  ${BIN} service list|show <key>      inspect registered services
  ${BIN} agent add <name>             register a requesting agent (prints a bearer token)
  ${BIN} agent list|rotate|disable    manage requesting agents
  ${BIN} policy allow <agent> <svc> <actions...>   grant access (actions: read provision signup *)
  ${BIN} policy list|remove           manage policies

${color.bold("runtime (agents):")}
  ${BIN} request --as <token> "..."   request access/resource in natural language
  ${BIN} serve [--http :8787] [--mcp] expose HTTP + MCP so remote agents can request

${color.bold("review:")}
  ${BIN} grants [--agent <name>]      list issued grants
  ${BIN} revoke <grant-id>            revoke a grant
  ${BIN} audit [-n N]                 audit log
  ${BIN} vault list [--reveal]        inspect the encrypted vault

${color.dim("env: MAJORDOMO_MASTER_KEY (unlock), MAJORDOMO_SIMULATE=1 (fake provisioning),")}
${color.dim("     ANTHROPIC_API_KEY (LLM brain + browser signup), MAJORDOMO_HOME (data dir)")}`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "-h":
      case "--help":
        console.log(HELP);
        break;
      case "version":
      case "-v":
      case "--version":
        console.log(VERSION);
        break;
      case "init":
        await (await import("./commands/init.ts")).cmdInit(rest);
        break;
      case "service":
        await (await import("./commands/service.ts")).cmdService(rest);
        break;
      case "agent":
        await (await import("./commands/agent.ts")).cmdAgent(rest);
        break;
      case "policy":
        await (await import("./commands/policy.ts")).cmdPolicy(rest);
        break;
      case "request":
        await (await import("./commands/request.ts")).cmdRequest(rest);
        break;
      case "serve":
        await (await import("./commands/serve.ts")).cmdServe(rest);
        break;
      case "grants":
        await (await import("./commands/audit.ts")).cmdGrants(rest);
        break;
      case "revoke":
        await (await import("./commands/audit.ts")).cmdRevoke(rest);
        break;
      case "audit":
        await (await import("./commands/audit.ts")).cmdAudit(rest);
        break;
      case "vault":
        await (await import("./commands/vault.ts")).cmdVault(rest);
        break;
      default:
        log.err(`unknown command: ${cmd}`);
        console.log(`\n${HELP}`);
        process.exit(1);
    }
  } catch (e) {
    log.err((e as Error).message);
    if (process.env.MAJORDOMO_DEBUG) console.error(e);
    process.exit(1);
  }
}

main();
