// Browserbase connector. Browserbase has no public self-serve signup API, so this
// is the showcase for the *browser signup* path: if the org has no API key yet,
// the IT agent signs up via a real browser (Claude-guided) and captures the key.
import type { Connector, ConnectorContext, ProvisionResult } from "../types.ts";
import { browserSignup } from "./browser.ts";
import { randomToken } from "../util/crypto.ts";

const API = "https://api.browserbase.com/v1";

/** Ensure we have a Browserbase api_key + project_id, signing up if needed. */
async function ensureKeys(ctx: ConnectorContext): Promise<{ apiKey?: string; projectId?: string; signedUp: boolean; message: string }> {
  let apiKey = ctx.getSecret(ctx.service.rootSecretRefs["api_key"] ?? "");
  let projectId = ctx.getSecret(ctx.service.rootSecretRefs["project_id"] ?? "");
  if (apiKey && projectId) return { apiKey, projectId, signedUp: false, message: "using existing Browserbase keys" };

  // No keys → sign up on behalf of the org.
  const email = ctx.org.contactEmail || `it+browserbase@${ctx.org.slug}.com`;
  const result = await browserSignup(
    {
      serviceName: "Browserbase",
      signupUrl: "https://www.browserbase.com/sign-up",
      wantSecrets: ["api_key", "project_id"],
      account: { email, password: `Mjd-${randomToken(10)}!`, orgName: ctx.org.name },
    },
    ctx,
  );
  if (!result.ok) return { signedUp: false, message: result.message };

  apiKey = result.rootSecrets["api_key"];
  projectId = result.rootSecrets["project_id"];
  // Persist captured root secrets onto the service.
  if (apiKey) ctx.service.rootSecretRefs["api_key"] = ctx.putSecret("browserbase:api_key", apiKey);
  if (projectId) ctx.service.rootSecretRefs["project_id"] = ctx.putSecret("browserbase:project_id", projectId);
  ctx.service.account = result.account;
  ctx.service.status = "active";
  return { apiKey, projectId, signedUp: true, message: result.message };
}

export const browserbaseConnector: Connector = {
  key: "browserbase",
  mode: "browser",
  capabilities: [],

  async signup(ctx) {
    const r = await ensureKeys(ctx);
    return {
      ok: !!(r.apiKey && r.projectId),
      account: ctx.service.account ?? {},
      rootSecrets: { ...(r.apiKey ? { api_key: r.apiKey } : {}), ...(r.projectId ? { project_id: r.projectId } : {}) },
      message: r.message,
    };
  },

  async provision(ctx, action, params): Promise<ProvisionResult> {
    const keys = await ensureKeys(ctx);
    if (!keys.apiKey || !keys.projectId) {
      return { ok: false, resource: {}, secrets: {}, message: `could not obtain Browserbase access: ${keys.message}` };
    }

    if (action === "issue_keys") {
      return {
        ok: true,
        resource: { project_id: keys.projectId, dashboard: "https://www.browserbase.com/overview", signed_up: keys.signedUp },
        secrets: { browserbase_api_key: keys.apiKey, browserbase_project_id: keys.projectId },
        scopes: ["browser:session"],
        message: keys.signedUp ? `Signed up for Browserbase and issued API access. ${keys.message}` : "Issued Browserbase API access.",
      };
    }

    if (action === "create_session") {
      const projectId = String(params.project_id || keys.projectId);
      if (ctx.simulate) {
        const sid = `bb_sess_${randomToken(8)}`;
        return {
          ok: true,
          resource: { session_id: sid, project_id: projectId },
          secrets: { connect_url: `wss://connect.browserbase.com?sessionId=${sid}` },
          scopes: ["browser:session"],
          message: "[simulate] started Browserbase session.",
        };
      }
      const res = await fetch(`${API}/sessions`, {
        method: "POST",
        headers: { "X-BB-API-Key": keys.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) return { ok: false, resource: {}, secrets: {}, message: `Browserbase session error ${res.status}` };
      const sess = (await res.json()) as { id: string; connectUrl?: string };
      return {
        ok: true,
        resource: { session_id: sess.id, project_id: projectId },
        secrets: { connect_url: sess.connectUrl ?? "" },
        scopes: ["browser:session"],
        message: "Started Browserbase session.",
      };
    }

    return { ok: false, resource: {}, secrets: {}, message: `unsupported browserbase action: ${action}` };
  },
};
