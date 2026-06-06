// The UNIVERSAL connector. Works for ANY service — no per-service code required.
//
// Given a service (name + whatever URLs the human supplied) and a natural-language
// action, the IT agent runs a tool loop to actually provision the resource and
// capture the credentials to hand back. Its tools:
//   - read_url       : fetch a docs/dashboard page so it can learn the API
//   - http_request   : make authenticated API calls (root secrets injected by name,
//                      never exposed to the model — it references {{secret:NAME}})
//   - browser_signup : sign up for the service via a real browser when there is no
//                      API key yet, capturing the resulting keys (delegates to browser.ts)
//   - finish         : return the provisioned resource + secrets + scopes
//
// In simulate mode it fabricates a plausible result (no network, no LLM spend) so
// the whole harness is demonstrable offline.
import type { Connector, ConnectorContext, ProvisionResult } from "../types.ts";
import { randomToken } from "../util/crypto.ts";
import { runToolLoop, haveLLM } from "../agent/llm.ts";
import { browserSignup } from "./browser.ts";

const TOOLS = [
  {
    name: "read_url",
    description: "Fetch the text content of a docs or dashboard URL to learn how to provision the resource.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "http_request",
    description: "Make an authenticated HTTP request to the service API. Reference vaulted root secrets as {{secret:NAME}} in url/headers/body — they are substituted server-side and never shown to you.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        url: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string", description: "Raw request body (JSON string or form-encoded)" },
      },
      required: ["method", "url"],
    },
  },
  {
    name: "browser_signup",
    description: "Sign up for the service via a real browser to obtain root API credentials when none are configured. Returns the captured root secrets.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { want_secrets: { type: "array", items: { type: "string" }, description: "names of credentials to capture, e.g. api_key" } },
      required: ["want_secrets"],
    },
  },
  {
    name: "finish",
    description: "Return the provisioned resource and the credentials to hand to the requesting agent.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        resource: { type: "object", additionalProperties: true, description: "human-readable description of what was created (ids, urls, region...)" },
        secrets: { type: "object", additionalProperties: { type: "string" }, description: "credentials to return to the agent: name -> value" },
        scopes: { type: "array", items: { type: "string" } },
        message: { type: "string" },
      },
      required: ["ok", "message"],
    },
  },
] as const;

function substituteSecrets(text: string, ctx: ConnectorContext): string {
  return text.replace(/\{\{secret:([a-zA-Z0-9_]+)\}\}/g, (_m, name: string) => {
    const ref = ctx.service.rootSecretRefs[name];
    const val = ref ? ctx.getSecret(ref) : undefined;
    return val ?? `{{missing:${name}}}`;
  });
}

function simulated(ctx: ConnectorContext, action: string): ProvisionResult {
  const key = ctx.service.catalogKey;
  ctx.log(`[simulate] agentic connector provisioned ${key}:${action}`);
  return {
    ok: true,
    resource: { service: key, action, id: `${key}_${randomToken(5)}`, dashboard: ctx.service.homepage ?? `https://${key}.com` },
    secrets: { api_key: `${key}_${randomToken(20)}` },
    scopes: ["api:default"],
    message: `[simulate] ${ctx.service.displayName}: fulfilled "${action}" and issued credentials.`,
  };
}

export const agenticConnector: Connector = {
  key: "*",
  mode: "api",
  capabilities: [],

  async signup(ctx) {
    const want = ctx.service.rootSecretNames ?? ["api_key"];
    if (ctx.simulate) {
      const r = browserSignupSim(ctx, want);
      return r;
    }
    const res = await browserSignup(
      {
        serviceName: ctx.service.displayName,
        signupUrl: ctx.service.signupUrl ?? ctx.service.homepage ?? `https://${ctx.service.catalogKey}.com`,
        wantSecrets: want,
        account: { email: ctx.org.contactEmail, password: `Mjd-${randomToken(10)}!`, orgName: ctx.org.name },
      },
      ctx,
    );
    if (res.ok) for (const [n, v] of Object.entries(res.rootSecrets)) ctx.service.rootSecretRefs[n] = ctx.putSecret(`${ctx.service.catalogKey}:${n}`, v);
    return res;
  },

  async provision(ctx, action, params): Promise<ProvisionResult> {
    if (ctx.simulate) return simulated(ctx, action);
    if (!haveLLM()) {
      return { ok: false, resource: {}, secrets: {}, message: "the universal connector needs ANTHROPIC_API_KEY to drive provisioning (or run with MAJORDOMO_SIMULATE=1)" };
    }

    const haveSecrets = Object.entries(ctx.service.rootSecretRefs).filter(([, ref]) => ctx.getSecret(ref)).map(([n]) => n);
    const wantSecrets = ctx.service.rootSecretNames ?? Object.keys(ctx.service.rootSecretRefs);

    const system = `You are majordomo, the IT manager agent for "${ctx.org.name}". Fulfil a request by provisioning a real resource on an external service and returning credentials.

SERVICE: ${ctx.service.displayName}
  homepage: ${ctx.service.homepage ?? "(unknown)"}
  api base: ${ctx.service.apiBase ?? "(discover from docs)"}
  docs:     ${ctx.service.docsUrl ?? "(none provided)"}
  signup:   ${ctx.service.signupUrl ?? "(none provided)"}
  configured root secrets (usable as {{secret:NAME}}): ${haveSecrets.join(", ") || "NONE"}

REQUESTED ACTION: ${action}
PARAMETERS: ${JSON.stringify(params)}

How to work:
1. If no root secret is configured and you need one, call browser_signup with want_secrets=${JSON.stringify(wantSecrets)} to create an account and capture API credentials.
2. Read docs with read_url if you are unsure of the API shape.
3. Use http_request to provision the resource. Put credentials in headers as {{secret:NAME}} — you will never see the raw value.
4. When done, call finish with the created resource and the credentials to give the requesting agent. Prefer returning a SCOPED key/resource, not the org's root admin key.
Keep it to a few steps. If you truly cannot proceed (paywall, captcha, missing capability), call finish with ok=false and a clear message.`;

    let signedUpSecrets: Record<string, string> = {};
    const loop = await runToolLoop({
      system,
      userPrompt: `Provision: ${action} with ${JSON.stringify(params)} on ${ctx.service.displayName}. Return the credentials.`,
      tools: TOOLS as unknown as { name: string; description: string; input_schema: Record<string, unknown> }[],
      maxSteps: 14,
      onStep: (name, input) => ctx.log(`agentic ${name}: ${JSON.stringify(input).slice(0, 200)}`),
      execute: async (name, input) => {
        if (name === "read_url") {
          const url = String((input as any).url);
          try {
            const res = await fetch(url, { headers: { "User-Agent": "majordomo/0.1" } });
            const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000);
            return { result: `HTTP ${res.status}\n${text}` };
          } catch (e) { return { result: `fetch error: ${(e as Error).message}` }; }
        }
        if (name === "http_request") {
          const i = input as any;
          const url = substituteSecrets(String(i.url), ctx);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(i.headers ?? {})) headers[k] = substituteSecrets(String(v), ctx);
          const body = i.body ? substituteSecrets(String(i.body), ctx) : undefined;
          try {
            const res = await fetch(url, { method: i.method, headers, body });
            const text = (await res.text()).slice(0, 4000);
            return { result: `HTTP ${res.status}\n${text}` };
          } catch (e) { return { result: `request error: ${(e as Error).message}` }; }
        }
        if (name === "browser_signup") {
          const want = ((input as any).want_secrets as string[]) ?? wantSecrets;
          const res = await browserSignup(
            {
              serviceName: ctx.service.displayName,
              signupUrl: ctx.service.signupUrl ?? ctx.service.homepage ?? "",
              wantSecrets: want,
              account: { email: ctx.org.contactEmail, password: `Mjd-${randomToken(10)}!`, orgName: ctx.org.name },
            },
            ctx,
          );
          if (res.ok) {
            for (const [n, v] of Object.entries(res.rootSecrets)) {
              ctx.service.rootSecretRefs[n] = ctx.putSecret(`${ctx.service.catalogKey}:${n}`, v);
              signedUpSecrets[n] = v;
            }
            ctx.service.account = res.account;
          }
          return { result: `${res.ok ? "signed up" : "signup failed"}: ${res.message}. captured: ${Object.keys(res.rootSecrets).join(", ") || "none"} (now usable as {{secret:NAME}})` };
        }
        if (name === "finish") {
          const i = input as any;
          return { result: "ok", stop: true, final: i };
        }
        return { result: `unknown tool ${name}` };
      },
    });

    const fin = loop.final as { ok?: boolean; resource?: Record<string, unknown>; secrets?: Record<string, string>; scopes?: string[]; message?: string } | undefined;
    if (!fin) return { ok: false, resource: {}, secrets: {}, message: loop.text || "agent did not finish provisioning" };
    return {
      ok: fin.ok !== false,
      resource: fin.resource ?? {},
      secrets: fin.secrets ?? {},
      scopes: fin.scopes ?? [],
      message: fin.message ?? "provisioned",
    };
  },
};

function browserSignupSim(ctx: ConnectorContext, want: string[]): { ok: boolean; account: Record<string, unknown>; rootSecrets: Record<string, string>; message: string } {
  const rootSecrets: Record<string, string> = {};
  for (const n of want) rootSecrets[n] = `${ctx.service.catalogKey}_${randomToken(10)}`;
  for (const [n, v] of Object.entries(rootSecrets)) ctx.service.rootSecretRefs[n] = ctx.putSecret(`${ctx.service.catalogKey}:${n}`, v);
  return { ok: true, account: { email: ctx.org.contactEmail }, rootSecrets, message: `[simulate] signed up for ${ctx.service.displayName}` };
}
