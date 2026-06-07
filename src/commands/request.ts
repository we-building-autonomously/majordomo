// `it request --as <token> "<natural language request>"`
// The agent-facing entrypoint: present a bearer token, describe what you need,
// receive scoped credentials (or a denial / approval-pending response).
import { loadCtx } from "../context.ts";
import { parseArgs, str, bool } from "../util/args.ts";
import { sha256 } from "../util/crypto.ts";
import { fulfill } from "../agent/brain.ts";
import { isSimulate } from "../config.ts";
import { log, color } from "../util/log.ts";

export async function cmdRequest(argv: string[]): Promise<void> {
  const { _, flags } = parseArgs(argv);
  const token = str(flags, "as");
  const prompt = _.join(" ").trim();
  const asJson = bool(flags, "json");

  if (!token || !prompt) {
    log.err('usage: it request --as <token> "<what you need>" [--json]');
    process.exit(1);
  }

  const { store, vault } = await loadCtx();
  const agent = store.agentByTokenHash(sha256(token));
  if (!agent) {
    if (asJson) { process.stdout.write(JSON.stringify({ ok: false, error: "invalid or disabled token" }) + "\n"); }
    else log.err("invalid or disabled agent token");
    process.exit(1);
  }

  if (!asJson) log.step(`${color.cyan(agent.name)} requests: "${prompt}"${isSimulate() ? color.dim(" [simulate]") : ""}`);

  const result = await fulfill(store, vault, agent, prompt);

  if (asJson) {
    process.stdout.write(JSON.stringify({
      ok: result.outcome === "fulfilled",
      outcome: result.outcome,
      message: result.message,
      decision: result.decision,
      resource: result.resource,
      secrets: result.secrets,
      grant_id: result.grant?.id,
    }, null, 2) + "\n");
    return;
  }

  if (result.decision) {
    log.detail(`→ ${result.decision.serviceKey}:${result.decision.action}  ${color.dim(result.decision.reasoning ?? "")}`);
  }

  switch (result.outcome) {
    case "fulfilled":
      log.ok(result.message);
      if (result.resource && Object.keys(result.resource).length) {
        log.info(color.bold("\n  resource:"));
        for (const [k, v] of Object.entries(result.resource)) log.detail(`${k}: ${v}`);
      }
      if (result.secrets && Object.keys(result.secrets).length) {
        log.info(color.bold("\n  credentials (also vaulted):"));
        for (const [k, v] of Object.entries(result.secrets)) log.info(`  ${color.green(k)}: ${color.bold(String(v))}`);
      }
      log.detail(`\ngrant ${result.grant?.id}`);
      break;
    case "denied":
      log.err(result.message); break;
    case "pending-approval":
      log.warn(result.message);
      log.detail("a human can review with: it audit"); break;
    case "needs-signup":
      log.warn(result.message); break;
    case "error":
      log.err(result.message); break;
  }
  log.info("");
}
