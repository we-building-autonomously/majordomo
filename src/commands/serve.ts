// `majordomo serve` — expose the IT manager so other agents can request access.
//   majordomo serve                 HTTP API on 127.0.0.1:8787
//   majordomo serve --http :9000    HTTP on a custom addr
//   majordomo serve --mcp           MCP server over stdio (for MCP-speaking agents)
import { loadCtxUnattended } from "../context.ts";
import { parseArgs, str, bool } from "../util/args.ts";
import { startHttp } from "../server/http.ts";
import { startMcp } from "../server/mcp.ts";
import { log } from "../util/log.ts";

function parseAddr(v: string, defHost: string, defPort: number): { host: string; port: number } {
  if (!v || v === "true") return { host: defHost, port: defPort };
  const m = v.match(/^(?:([^:]*):)?(\d+)$/);
  if (!m) return { host: defHost, port: defPort };
  return { host: m[1] || defHost, port: Number(m[2]) };
}

export async function cmdServe(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const mcp = bool(flags, "mcp");

  // Unlock the vault. For MCP (stdio) we must not prompt — require the env key.
  const ctx = await loadCtxUnattended();

  if (mcp) {
    // stdio mode: no stdout logging.
    startMcp(ctx.vault);
    return;
  }

  const { host, port } = parseAddr(str(flags, "http"), "127.0.0.1", 8787);
  log.info("");
  startHttp(ctx.vault, host, port);
  // keep process alive
}
