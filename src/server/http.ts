// HTTP API so remote agents can request access. Bearer-token auth = the agent's token.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "../store.ts";
import type { Vault } from "../vault.ts";
import { sha256 } from "../util/crypto.ts";
import { fulfill } from "../agent/brain.ts";
import { log, color } from "../util/log.ts";

function send(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(s);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7).trim();
  return undefined;
}

export function startHttp(vault: Vault, host: string, port: number): void {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, service: "majordomo", org: Store.load().org()?.name });
      }

      // All other routes require a valid agent token.
      const token = bearer(req);
      const store = Store.load(); // reload to pick up external changes
      const agent = token ? store.agentByTokenHash(sha256(token)) : undefined;
      if (!agent) return send(res, 401, { ok: false, error: "missing or invalid bearer token" });

      if (req.method === "GET" && url.pathname === "/capabilities") {
        return send(res, 200, {
          ok: true,
          services: store.services().map((s) => ({ key: s.catalogKey, name: s.displayName, status: s.status, mode: s.mode })),
        });
      }

      if (req.method === "GET" && url.pathname === "/grants") {
        return send(res, 200, {
          ok: true,
          grants: store.grantsFor(agent.id).map((g) => ({ id: g.id, service: g.serviceKey, action: g.action, resource: g.resource, scopes: g.scopes, createdAt: g.createdAt })),
        });
      }

      if (req.method === "POST" && url.pathname === "/request") {
        const raw = await readBody(req);
        let prompt = "";
        try { prompt = String(JSON.parse(raw || "{}").prompt || ""); } catch { /* ignore */ }
        if (!prompt) return send(res, 400, { ok: false, error: "body must be { prompt: string }" });
        log.step(`[http] ${agent.name}: "${prompt}"`);
        const result = await fulfill(store, vault, agent, prompt);
        return send(res, result.outcome === "fulfilled" ? 200 : 202, {
          ok: result.outcome === "fulfilled",
          outcome: result.outcome,
          message: result.message,
          resource: result.resource,
          secrets: result.secrets,
          scopes: result.grant?.scopes,
          grant_id: result.grant?.id,
        });
      }

      send(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      send(res, 500, { ok: false, error: (e as Error).message });
    }
  });

  server.listen(port, host, () => {
    log.ok(`HTTP API on ${color.bold(`http://${host}:${port}`)}`);
    log.detail(`POST /request  (Bearer <agent-token>)  body { "prompt": "..." }`);
    log.detail(`GET  /capabilities · GET /grants · GET /health`);
  });
}
