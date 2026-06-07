// Human dashboard: a local web UI to see what the IT agent has done and act on it
// (revoke grants, approve/deny queued requests, disable agents). Read endpoints never
// expose secret values — only the names of the secrets held in the vault.
//
// Auth: the server mints a random session key at startup and prints it in the URL.
// Every /api call must present it (header `x-mjd-dash` or `?k=`). Bound to localhost.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "../store.ts";
import type { Vault } from "../vault.ts";
import { fulfill } from "../agent/brain.ts";
import { isSimulate } from "../config.ts";
import { randomToken, constantTimeEqual } from "../util/crypto.ts";
import { log, color } from "../util/log.ts";

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

/** Snapshot of everything the human reviews — reloaded fresh so external CLI changes show up. */
function buildState() {
  const store = Store.load();
  const agentName = new Map(store.agents().map((a) => [a.id, a.name]));
  const svcName = (key: string) => store.service(key)?.displayName ?? key;

  return {
    org: store.org() ?? null,
    simulate: isSimulate(),
    services: store.services().map((s) => ({
      key: s.catalogKey,
      name: s.displayName,
      status: s.status,
      mode: s.mode,
      adhoc: !!s.adhoc,
      dashboardUrl: s.account?.dashboardUrl,
    })),
    agents: store.agents().map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description ?? "",
      disabled: a.disabled,
      tokenPrefix: a.tokenPrefix,
      grants: store.grantsFor(a.id).length,
    })),
    policies: store.policies().map((p) => ({
      id: p.id,
      agent: p.agentId === "*" ? "*" : agentName.get(p.agentId) ?? p.agentId,
      service: p.serviceKey === "*" ? "*" : svcName(p.serviceKey),
      actions: p.actions,
      maxGrants: p.maxGrants,
      requiresApproval: p.requiresApproval,
    })),
    grants: store.grants().map((g) => ({
      id: g.id,
      agent: agentName.get(g.agentId) ?? g.agentId,
      service: g.serviceKey,
      action: g.action,
      status: g.status,
      resource: g.resource,
      scopes: g.scopes,
      secrets: Object.keys(g.secretRefs), // names only — values stay vaulted
      createdAt: g.createdAt,
    })),
    pending: store.pendingRequests().map((r) => ({
      id: r.id,
      agent: agentName.get(r.agentId) ?? r.agentId,
      prompt: r.prompt,
      service: r.decision?.serviceKey,
      action: r.decision?.action,
      createdAt: r.createdAt,
    })),
    audit: store.auditLog().slice(0, 80).map((e) => ({
      at: e.at,
      actor: agentName.get(e.actor) ?? e.actor,
      event: e.event,
      detail: e.detail,
    })),
  };
}

export function startDashboard(vault: Vault, host: string, port: number): void {
  const key = randomToken(18);

  const authed = (req: IncomingMessage): boolean => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    const presented = (req.headers["x-mjd-dash"] as string) || url.searchParams.get("k") || "";
    return !!presented && constantTimeEqual(presented, key);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);

      // The page itself is harmless (no data); it fetches /api/* with the key.
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (!authed(req)) return json(res, 401, { ok: false, error: "unauthorized — open the dashboard via the printed URL" });

        if (req.method === "GET" && url.pathname === "/api/state") {
          return json(res, 200, { ok: true, state: buildState() });
        }

        if (req.method === "POST" && url.pathname === "/api/grant/revoke") {
          const { id } = JSON.parse((await readBody(req)) || "{}");
          const store = Store.load();
          const g = store.grant(id);
          if (!g) return json(res, 404, { ok: false, error: "grant not found" });
          g.status = "revoked";
          g.revokedAt = new Date().toISOString();
          store.addGrant(g);
          store.audit("human", "grant.revoke", { grant: g.id, via: "dashboard" });
          return json(res, 200, { ok: true });
        }

        if (req.method === "POST" && url.pathname === "/api/agent/disable") {
          const { id, disabled } = JSON.parse((await readBody(req)) || "{}");
          const store = Store.load();
          const a = store.agent(id);
          if (!a) return json(res, 404, { ok: false, error: "agent not found" });
          a.disabled = !!disabled;
          store.addAgent(a);
          store.audit("human", disabled ? "agent.disable" : "agent.enable", { agent: a.id, via: "dashboard" });
          return json(res, 200, { ok: true });
        }

        if (req.method === "POST" && url.pathname === "/api/request/deny") {
          const { id } = JSON.parse((await readBody(req)) || "{}");
          const store = Store.load();
          const r = store.request(id);
          if (!r || r.outcome !== "pending-approval") return json(res, 404, { ok: false, error: "pending request not found" });
          store.setRequestOutcome(id, "denied", "denied by human from dashboard");
          store.audit("human", "request.deny", { request: id, agent: r.agentId, via: "dashboard" });
          return json(res, 200, { ok: true });
        }

        if (req.method === "POST" && url.pathname === "/api/request/approve") {
          const { id } = JSON.parse((await readBody(req)) || "{}");
          const store = Store.load();
          const r = store.request(id);
          if (!r || r.outcome !== "pending-approval") return json(res, 404, { ok: false, error: "pending request not found" });
          const agent = store.agent(r.agentId);
          if (!agent) return json(res, 404, { ok: false, error: "requesting agent no longer exists" });
          store.audit("human", "request.approve", { request: id, agent: agent.id, via: "dashboard" });
          // Re-run fulfilment, bypassing the approval gate; drop the now-resolved pending record.
          const result = await fulfill(store, vault, agent, r.prompt, { skipApproval: true });
          store.removeRequest(id);
          return json(res, result.outcome === "fulfilled" ? 200 : 202, {
            ok: result.outcome === "fulfilled",
            outcome: result.outcome,
            message: result.message,
          });
        }

        return json(res, 404, { ok: false, error: "unknown endpoint" });
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    } catch (e) {
      json(res, 500, { ok: false, error: (e as Error).message });
    }
  });

  server.listen(port, host, () => {
    const u = `http://${host}:${port}/?k=${key}`;
    log.ok(`dashboard on ${color.bold(`http://${host}:${port}`)}`);
    log.info("");
    log.info(`  open: ${color.cyan(u)}`);
    log.detail("the key in the URL authorizes this session — keep it local. Ctrl-C to stop.");
    log.info("");
  });
}

// Single self-contained page: no build, no external assets.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>majordomo · IT manager</title>
<style>
  :root{
    --bg:#0b0d10; --panel:#13171c; --panel2:#171c22; --line:#232a32;
    --fg:#e6edf3; --dim:#8a96a3; --acc:#5db0ff; --green:#3fb950; --red:#f85149;
    --yellow:#d29922; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--mono)}
  header{display:flex;align-items:center;gap:14px;padding:16px 22px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(11,13,16,.92);backdrop-filter:blur(6px);z-index:5}
  header h1{font-size:16px;margin:0;letter-spacing:.5px}
  header h1 small{color:var(--dim);font-weight:400}
  .counts{display:flex;gap:18px;color:var(--dim);font-size:12px;margin-left:auto}
  .counts b{color:var(--fg)}
  .badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
  .badge.sim{color:var(--yellow);border-color:var(--yellow)}
  .badge.live{color:var(--green);border-color:var(--green)}
  main{max-width:1080px;margin:0 auto;padding:22px;display:flex;flex-direction:column;gap:22px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  section>h2{margin:0;padding:12px 16px;font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}
  section>h2 .n{color:var(--fg);background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:11px}
  table{width:100%;border-collapse:collapse}
  td,th{text-align:left;padding:9px 16px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.6px}
  tr:last-child td{border-bottom:none}
  .id{color:var(--dim);font-size:12px}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  .dot.active,.dot.configured{background:var(--green)} .dot.revoked,.dot.disabled{background:var(--red)}
  .dot.pending,.dot\\.needs-signup{background:var(--yellow)} .dot.error{background:var(--red)}
  .pill{font-size:11px;border:1px solid var(--line);border-radius:6px;padding:1px 7px;color:var(--dim)}
  button{font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--fg);border-radius:7px;padding:5px 11px}
  button:hover{border-color:var(--acc)}
  button.danger:hover{border-color:var(--red);color:var(--red)}
  button.go{border-color:var(--green);color:var(--green)}
  button.go:hover{background:rgba(63,185,80,.1)}
  .muted{color:var(--dim)}
  .empty{padding:16px;color:var(--dim)}
  .approve{background:linear-gradient(180deg,#1a1d14,#13171c)}
  .approve>h2{color:var(--yellow)}
  .req{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:flex-start}
  .req:last-child{border-bottom:none}
  .req .q{flex:1}
  .req .q .p{color:var(--fg)} .req .q .meta{color:var(--dim);font-size:12px;margin-top:3px}
  .secrets{color:var(--yellow)}
  .log{font-size:12.5px;max-height:340px;overflow:auto}
  .log td{padding:6px 16px;border-bottom:1px solid #1b2026}
  .log .ev{color:var(--acc)} .log .at{color:var(--dim);white-space:nowrap}
  .log .d{color:var(--dim);word-break:break-word}
  .err{color:var(--red);padding:14px 22px}
  .foot{color:var(--dim);font-size:12px;text-align:center;padding:0 0 30px}
  a{color:var(--acc);text-decoration:none} a:hover{text-decoration:underline}
</style>
</head>
<body>
<header>
  <h1>majordomo <small>· IT manager</small></h1>
  <span id="mode" class="badge"></span>
  <div class="counts" id="counts"></div>
</header>
<main id="root"><div class="empty">loading…</div></main>
<div class="foot">read-only view of services, agents &amp; policies · actions are audited · secrets stay vaulted</div>
<script>
const KEY = new URLSearchParams(location.search).get('k') || '';
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago = iso => { const d=(Date.now()-new Date(iso))/1000; if(d<60)return Math.floor(d)+'s ago'; if(d<3600)return Math.floor(d/60)+'m ago'; if(d<86400)return Math.floor(d/3600)+'h ago'; return Math.floor(d/86400)+'d ago'; };
const hhmm = iso => esc(String(iso).replace('T',' ').slice(0,19));

async function api(path, body){
  const r = await fetch(path, {method: body?'POST':'GET', headers:{'x-mjd-dash':KEY,'Content-Type':'application/json'}, body: body?JSON.stringify(body):undefined});
  return r.json();
}
async function act(path, body, confirmMsg){
  if(confirmMsg && !confirm(confirmMsg)) return;
  const r = await api(path, body||{});
  if(!r.ok && r.error) alert(r.error);
  if(r.message) {/* approve returns a message */ }
  load();
}

function section(title, n, inner, cls){
  return '<section class="'+(cls||'')+'"><h2>'+title+(n!=null?' <span class="n">'+n+'</span>':'')+'</h2>'+inner+'</section>';
}

function render(s){
  document.getElementById('mode').className = 'badge '+(s.simulate?'sim':'live');
  document.getElementById('mode').textContent = s.simulate?'SIMULATE':'LIVE';
  document.getElementById('counts').innerHTML =
    '<span><b>'+s.services.length+'</b> services</span>'+
    '<span><b>'+s.agents.length+'</b> agents</span>'+
    '<span><b>'+s.grants.filter(g=>g.status==='active').length+'</b> active grants</span>'+
    (s.pending.length?'<span style="color:var(--yellow)"><b>'+s.pending.length+'</b> pending</span>':'');

  let html = '';

  // Pending approvals (only when present)
  if(s.pending.length){
    let rows = s.pending.map(p=>'<div class="req"><div class="q"><div class="p">“'+esc(p.prompt)+'”</div>'+
      '<div class="meta">'+esc(p.agent)+' · '+esc(p.service||'?')+'/'+esc(p.action||'?')+' · '+ago(p.createdAt)+'</div></div>'+
      '<button class="go" onclick="act(\\'/api/request/approve\\',{id:\\''+p.id+'\\'},\\'Approve and provision now?\\')">approve</button>'+
      '<button class="danger" onclick="act(\\'/api/request/deny\\',{id:\\''+p.id+'\\'})">deny</button></div>').join('');
    html += section('Pending approval', s.pending.length, rows, 'approve');
  }

  // Grants
  html += section('Grants', s.grants.length, s.grants.length ? '<table><tr><th>grant</th><th>agent</th><th>service / action</th><th>resource</th><th>secrets</th><th></th></tr>'+
    s.grants.map(g=>'<tr><td><span class="dot '+esc(g.status)+'"></span><span class="id">'+esc(g.id)+'</span></td>'+
      '<td>'+esc(g.agent)+'</td><td>'+esc(g.service)+' / '+esc(g.action)+'</td>'+
      '<td class="muted">'+esc(JSON.stringify(g.resource))+'</td>'+
      '<td class="secrets">'+(g.secrets.length?g.secrets.map(esc).join(', '):'<span class="muted">—</span>')+'</td>'+
      '<td>'+(g.status==='active'?'<button class="danger" onclick="act(\\'/api/grant/revoke\\',{id:\\''+g.id+'\\'},\\'Revoke '+g.id+'?\\')">revoke</button>':'<span class="pill">'+esc(g.status)+'</span>')+'</td></tr>').join('')+'</table>'
    : '<div class="empty">no grants issued yet</div>');

  // Agents
  html += section('Agents', s.agents.length, s.agents.length ? '<table><tr><th>agent</th><th>token</th><th>grants</th><th></th></tr>'+
    s.agents.map(a=>'<tr><td><span class="dot '+(a.disabled?'disabled':'active')+'"></span>'+esc(a.name)+(a.description?' <span class="muted">— '+esc(a.description)+'</span>':'')+'</td>'+
      '<td class="id">'+esc(a.tokenPrefix)+'…</td><td class="muted">'+a.grants+'</td>'+
      '<td>'+(a.disabled
        ? '<button class="go" onclick="act(\\'/api/agent/disable\\',{id:\\''+a.id+'\\',disabled:false})">enable</button>'
        : '<button class="danger" onclick="act(\\'/api/agent/disable\\',{id:\\''+a.id+'\\',disabled:true},\\'Disable '+esc(a.name)+'? It can no longer request access.\\')">disable</button>')+
      '</td></tr>').join('')+'</table>'
    : '<div class="empty">no agents registered</div>');

  // Services
  html += section('Services', s.services.length, s.services.length ? '<table><tr><th>service</th><th>status</th><th>mode</th><th></th></tr>'+
    s.services.map(v=>'<tr><td><span class="dot '+esc(v.status)+'"></span>'+esc(v.name)+(v.adhoc?' <span class="pill">ad-hoc</span>':'')+'</td>'+
      '<td>'+esc(v.status)+'</td><td class="muted">'+esc(v.mode)+'</td>'+
      '<td>'+(v.dashboardUrl?'<a href="'+esc(v.dashboardUrl)+'" target="_blank">open ↗</a>':'')+'</td></tr>').join('')+'</table>'
    : '<div class="empty">no services registered</div>');

  // Policies
  html += section('Policies', s.policies.length, s.policies.length ? '<table><tr><th>policy</th><th>agent</th><th>service</th><th>actions</th><th>limit</th></tr>'+
    s.policies.map(p=>'<tr><td class="id">'+esc(p.id)+'</td><td>'+esc(p.agent)+'</td><td>'+esc(p.service)+'</td>'+
      '<td>'+p.actions.map(a=>'<span class="pill">'+esc(a)+'</span>').join(' ')+(p.requiresApproval?' <span class="pill" style="color:var(--yellow)">approval</span>':'')+'</td>'+
      '<td class="muted">'+(p.maxGrants>0?p.maxGrants:'∞')+'</td></tr>').join('')+'</table>'
    : '<div class="empty">no policies</div>');

  // Audit
  html += section('Audit log', null, s.audit.length ? '<div class="log"><table>'+
    s.audit.map(e=>'<tr><td class="at">'+hhmm(e.at)+'</td><td>'+esc(e.actor)+'</td><td class="ev">'+esc(e.event)+'</td><td class="d">'+esc(JSON.stringify(e.detail))+'</td></tr>').join('')+'</table></div>'
    : '<div class="empty">no activity yet</div>');

  document.getElementById('root').innerHTML = html;
}

async function load(){
  try{
    const r = await api('/api/state');
    if(!r.ok){ document.getElementById('root').innerHTML='<div class="err">'+esc(r.error||'error')+'</div>'; return; }
    render(r.state);
  }catch(e){ document.getElementById('root').innerHTML='<div class="err">'+esc(e.message)+'</div>'; }
}
load();
setInterval(load, 4000);
</script>
</body>
</html>`;
