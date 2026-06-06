// Supabase connector — provisions projects / keys via the Management API.
// Falls back to realistic simulated resources when ctx.simulate is set.
import type { Connector, ConnectorContext, ProvisionResult } from "../types.ts";
import { randomToken } from "../util/crypto.ts";

const API = "https://api.supabase.com/v1";

async function createProject(ctx: ConnectorContext, params: Record<string, unknown>): Promise<ProvisionResult> {
  const name = String(params.name || `db-${randomToken(3)}`);
  const region = String(params.region || "us-east-1");

  if (ctx.simulate) {
    const ref = randomToken(8).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
    const dbPass = randomToken(16);
    ctx.log(`[simulate] created Supabase project "${name}" (${ref}) in ${region}`);
    return {
      ok: true,
      resource: {
        project_ref: ref,
        name,
        region,
        host: `db.${ref}.supabase.co`,
        dashboard: `https://supabase.com/dashboard/project/${ref}`,
      },
      secrets: {
        database_url: `postgresql://postgres:${dbPass}@db.${ref}.supabase.co:5432/postgres`,
        anon_key: `eyJ_anon_${randomToken(20)}`,
        service_role_key: `eyJ_service_${randomToken(20)}`,
      },
      scopes: ["db:read", "db:write"],
      message: `Provisioned Supabase Postgres project "${name}" in ${region}.`,
    };
  }

  const token = ctx.getSecret(ctx.service.rootSecretRefs["access_token"] ?? "");
  const orgId = ctx.getSecret(ctx.service.rootSecretRefs["organization_id"] ?? "");
  if (!token || !orgId) return { ok: false, resource: {}, secrets: {}, message: "missing Supabase access_token/organization_id — set them or run in simulate mode" };

  const dbPass = randomToken(16);
  const res = await fetch(`${API}/projects`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, organization_id: orgId, region, db_pass: dbPass, plan: String(params.plan || "free") }),
  });
  if (!res.ok) return { ok: false, resource: {}, secrets: {}, message: `Supabase API error ${res.status}: ${await res.text()}` };
  const proj = (await res.json()) as { id: string; ref?: string; name: string };
  const ref = proj.ref || proj.id;
  return {
    ok: true,
    resource: { project_ref: ref, name: proj.name, region, host: `db.${ref}.supabase.co`, dashboard: `https://supabase.com/dashboard/project/${ref}` },
    secrets: { database_url: `postgresql://postgres:${dbPass}@db.${ref}.supabase.co:5432/postgres` },
    scopes: ["db:read", "db:write"],
    message: `Created Supabase project "${proj.name}".`,
  };
}

export const supabaseConnector: Connector = {
  key: "supabase",
  mode: "api",
  capabilities: [],
  async provision(ctx, action, params) {
    if (action === "create_project" || action === "create_api_key") return createProject(ctx, params);
    return { ok: false, resource: {}, secrets: {}, message: `unsupported supabase action: ${action}` };
  },
};
