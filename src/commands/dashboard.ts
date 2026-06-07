// `it dashboard` — a local web UI for the human to review and act on what the IT
// agent has done (revoke grants, approve/deny queued requests, disable agents).
//   it dashboard                 http://127.0.0.1:7788
//   it dashboard --http :9000    custom port
import { loadCtx } from "../context.ts";
import { parseArgs, str } from "../util/args.ts";
import { startDashboard } from "../server/dashboard.ts";

function parseAddr(v: string, defHost: string, defPort: number): { host: string; port: number } {
  if (!v || v === "true") return { host: defHost, port: defPort };
  const m = v.match(/^(?:([^:]*):)?(\d+)$/);
  if (!m) return { host: defHost, port: defPort };
  return { host: m[1] || defHost, port: Number(m[2]) };
}

export async function cmdDashboard(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const ctx = await loadCtx(); // unlock the vault (master key)
  const { host, port } = parseAddr(str(flags, "http"), "127.0.0.1", 7788);
  startDashboard(ctx.vault, host, port);
  // the HTTP server keeps the process alive
}
