// Minimal MCP server (stdio, JSON-RPC 2.0, newline-delimited) so MCP-speaking agents
// can request access as a tool call. No SDK dependency. The connecting agent
// authenticates with its majordomo token via MAJORDOMO_AGENT_TOKEN (or the tool arg).
//
// Implements: initialize, tools/list, tools/call (+ ignores notifications).
// IMPORTANT: in MCP stdio mode, only JSON-RPC may go to stdout — logs go to stderr.
import { Store } from "../store.ts";
import type { Vault } from "../vault.ts";
import { sha256 } from "../util/crypto.ts";
import { fulfill } from "../agent/brain.ts";

type RpcReq = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: any };

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "request_access",
    description: "Ask the IT manager for access or a resource in natural language (e.g. 'I need a Postgres database', 'buy a phone number'). Returns provisioned credentials if policy allows.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What you need, in plain language." },
        token: { type: "string", description: "Your it agent token (or set MAJORDOMO_AGENT_TOKEN)." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_services",
    description: "List the services the IT manager can provision access to.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "my_grants",
    description: "List the access grants already issued to you.",
    inputSchema: { type: "object", properties: { token: { type: "string" } } },
  },
];

export function startMcp(vault: Vault): void {
  const out = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const errlog = (m: string) => process.stderr.write(`[mcp] ${m}\n`);

  const resolveAgent = (argToken?: string) => {
    const token = argToken || process.env.MAJORDOMO_AGENT_TOKEN || "";
    const store = Store.load();
    return { store, agent: token ? store.agentByTokenHash(sha256(token)) : undefined };
  };

  async function handle(req: RpcReq): Promise<void> {
    const reply = (result: unknown) => out({ jsonrpc: "2.0", id: req.id, result });
    const fail = (code: number, message: string) => out({ jsonrpc: "2.0", id: req.id, error: { code, message } });

    switch (req.method) {
      case "initialize":
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "majordomo", version: "0.1.0" },
        });
      case "notifications/initialized":
      case "initialized":
        return; // notification, no response
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = req.params?.name as string;
        const args = (req.params?.arguments ?? {}) as Record<string, any>;
        const text = (s: string, isError = false) => reply({ content: [{ type: "text", text: s }], isError });

        if (name === "list_services") {
          const store = Store.load();
          const list = store.services().map((s) => `- ${s.catalogKey} (${s.displayName}) [${s.status}]`).join("\n") || "(none registered)";
          return text(`Services majordomo manages:\n${list}`);
        }

        const { store, agent } = resolveAgent(args.token);
        if (!agent) return text("Not authenticated: provide your majordomo token via the `token` argument or MAJORDOMO_AGENT_TOKEN.", true);

        if (name === "my_grants") {
          const gs = store.grantsFor(agent.id);
          return text(gs.length ? gs.map((g) => `- ${g.id}: ${g.serviceKey}/${g.action} ${JSON.stringify(g.resource)}`).join("\n") : "No grants yet.");
        }

        if (name === "request_access") {
          const prompt = String(args.prompt || "");
          if (!prompt) return text("prompt is required", true);
          errlog(`request_access from ${agent.name}: ${prompt}`);
          const result = await fulfill(store, vault, agent, prompt);
          const payload = {
            outcome: result.outcome,
            message: result.message,
            resource: result.resource,
            secrets: result.secrets,
            grant_id: result.grant?.id,
          };
          return text(JSON.stringify(payload, null, 2), result.outcome !== "fulfilled");
        }

        return fail(-32601, `unknown tool: ${name}`);
      }
      default:
        if (req.id === undefined) return; // unknown notification
        return fail(-32601, `method not found: ${req.method}`);
    }
  }

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req: RpcReq;
      try { req = JSON.parse(line); } catch { errlog(`bad json: ${line.slice(0, 80)}`); continue; }
      handle(req).catch((e) => errlog(`handler error: ${(e as Error).message}`));
    }
  });
  process.stdin.on("end", () => process.exit(0));
  errlog("majordomo MCP server ready (stdio). tools: request_access, list_services, my_grants");
}
