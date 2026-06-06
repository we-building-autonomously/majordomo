// The IT-agent brain: turn a natural-language access request into a fulfilled,
// policy-checked grant. Uses Claude to map intent → service+action+params, with a
// keyword heuristic fallback when no ANTHROPIC_API_KEY is present.
import type { Store } from "../store.ts";
import type { Vault } from "../vault.ts";
import type { ConnectorContext, Grant, ProvisionResult, RequestingAgent, RequestRecord } from "../types.ts";
import { CATALOG, catalogEntry } from "../catalog.ts";
import { getConnector } from "../connectors/registry.ts";
import { evaluate } from "../policy.ts";
import { isSimulate } from "../config.ts";
import { id, nowISO } from "../util/id.ts";
import { callClaudeTools, haveLLM } from "./llm.ts";

export type FulfillResult = {
  outcome: RequestRecord["outcome"];
  message: string;
  grant?: Grant;
  /** Secret values returned to the requesting agent (plaintext, by name). */
  secrets?: Record<string, string>;
  resource?: Record<string, unknown>;
  decision?: { serviceKey?: string; action?: string; params?: Record<string, unknown>; reasoning?: string };
};

type Option = { serviceKey: string; action: string; title: string; description: string; registered: boolean };

const GENERIC_CAP = {
  action: "provision",
  title: "Provision a resource / issue credentials",
  description: "Sign up if needed, provision whatever the request describes, and return scoped credentials.",
};

function capsForService(store: Store, key: string) {
  const svc = store.service(key);
  if (svc?.capabilities?.length) return svc.capabilities;
  const entry = CATALOG[key];
  if (entry?.capabilities?.length) return entry.capabilities;
  return [GENERIC_CAP];
}

function availableOptions(store: Store): Option[] {
  const opts: Option[] = [];
  // Registered services first (the real surface), then catalog presets as suggestions.
  const keys = new Set<string>([...store.services().map((s) => s.catalogKey), ...Object.keys(CATALOG)]);
  for (const key of keys) {
    const svc = store.service(key);
    const display = svc?.displayName ?? CATALOG[key]?.displayName ?? key;
    for (const cap of capsForService(store, key)) {
      opts.push({ serviceKey: key, action: cap.action, title: `${display}: ${cap.title}`, description: cap.description, registered: !!svc });
    }
  }
  return opts;
}

/** Map a request to (serviceKey, action, params) via Claude. */
async function decideWithLLM(prompt: string, options: Option[]): Promise<{ serviceKey: string; action: string; params: Record<string, unknown>; reasoning: string } | null> {
  const optList = options
    .map((o) => `- ${o.serviceKey}:${o.action} — ${o.title}: ${o.description}${o.registered ? "" : " (NOT yet registered)"}`)
    .join("\n");

  const tool = {
    name: "choose_fulfillment",
    description: "Pick the single best service capability to fulfill the request and extract its parameters.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        service_key: { type: "string", description: "catalog key, e.g. supabase" },
        action: { type: "string", description: "capability action, e.g. create_project" },
        params: { type: "object", description: "extracted parameters as a flat object of strings", additionalProperties: true },
        reasoning: { type: "string", description: "one sentence on why" },
        fulfillable: { type: "boolean", description: "false if no listed capability matches" },
      },
      required: ["service_key", "action", "fulfillable"],
    },
  };

  const res = await callClaudeTools({
    system: `You are majordomo, an organization's IT manager agent. Another agent has asked for access or a resource. Map the request to exactly one available capability and extract parameters. Available capabilities:\n${optList}\n\nIf none fit, set fulfillable=false.`,
    messages: [{ role: "user", content: prompt }],
    tools: [tool],
    toolChoice: { type: "tool", name: "choose_fulfillment" },
    maxTokens: 700,
  });
  const call = res.toolCalls[0];
  if (!call) return null;
  const inp = call.input as { service_key: string; action: string; params?: Record<string, unknown>; reasoning?: string; fulfillable?: boolean };
  if (inp.fulfillable === false) return null;
  return { serviceKey: inp.service_key, action: inp.action, params: inp.params ?? {}, reasoning: inp.reasoning ?? "" };
}

/** Heuristic fallback: keyword-match the request onto a capability. */
function decideHeuristic(prompt: string, options: Option[]): { serviceKey: string; action: string; params: Record<string, unknown>; reasoning: string } | null {
  const p = prompt.toLowerCase();
  const score = (o: Option): number => {
    let s = 0;
    const hay = `${o.serviceKey} ${o.action} ${o.title} ${o.description}`.toLowerCase();
    for (const w of p.split(/[^a-z0-9]+/).filter((w) => w.length > 2)) if (hay.includes(w)) s += 1;
    // Explicitly naming the service in the prompt is the strongest signal.
    if (p.includes(o.serviceKey.toLowerCase())) s += 6;
    // domain keywords (only for catalog services with bespoke shapes)
    if (/(database|postgres|sql)/.test(p) && o.serviceKey === "supabase") s += 3;
    if (/(phone|number|sms|text message|call|twilio)/.test(p) && o.serviceKey === "twilio") s += 3;
    if (/(browser|headless|scrape|playwright)/.test(p) && o.serviceKey === "browserbase") s += 3;
    if (/(email|smtp|resend)/.test(p) && o.serviceKey === "resend") s += 3;
    if (/(llm|gpt|openai|completion)/.test(p) && o.serviceKey === "openai") s += 3;
    // Strongly prefer services the org has actually registered.
    if (o.registered) s += 4;
    return s;
  };
  const ranked = options.map((o) => ({ o, s: score(o) })).sort((a, b) => b.s - a.s);
  if (!ranked.length || ranked[0].s <= 1) return null;
  const best = ranked[0].o;
  const params: Record<string, unknown> = {};
  const area = p.match(/area code (\d{3})/)?.[1] || p.match(/\b(\d{3})\b/)?.[1];
  if (area && best.serviceKey === "twilio") params.area_code = area;
  const nameM = prompt.match(/(?:called|named)\s+([a-z0-9\-_]+)/i);
  if (nameM) params.name = nameM[1];
  return { serviceKey: best.serviceKey, action: best.action, params, reasoning: "keyword heuristic (no LLM key set)" };
}

/** Full fulfilment pipeline. */
export async function fulfill(store: Store, vault: Vault, agent: RequestingAgent, prompt: string): Promise<FulfillResult> {
  const org = store.requireOrg();
  const options = availableOptions(store);

  // 1. Decide intent.
  let decision = haveLLM() ? await decideWithLLM(prompt, options) : decideHeuristic(prompt, options);
  if (!decision) decision = decideHeuristic(prompt, options); // fallback if LLM declined
  if (!decision) {
    const rec = makeRecord(agent, prompt, "denied", "could not match request to any known service capability");
    store.addRequest(rec);
    return { outcome: "denied", message: rec.message, decision: undefined };
  }

  // 2. Service must be registered by a human first (catalog or free-form).
  const svc = store.service(decision.serviceKey);
  if (!svc) {
    const known = catalogEntry(decision.serviceKey);
    const msg = known
      ? `service "${decision.serviceKey}" is not registered — a human must run: majordomo service add ${decision.serviceKey}`
      : `no registered service matches "${decision.serviceKey}" — a human can add any service: majordomo service add ${decision.serviceKey} --signup-url <url>`;
    const rec = makeRecord(agent, prompt, "needs-signup", msg, decision);
    store.addRequest(rec);
    return { outcome: "needs-signup", message: msg, decision };
  }

  // 3. Policy check.
  const decisionPolicy = evaluate(store, agent, decision.serviceKey, "provision");
  const decisionSignup = svc.status === "needs-signup" ? evaluate(store, agent, decision.serviceKey, "signup") : null;
  // Need provision permission always; if signup is required, need that too (or provision implies it if action includes *).
  if (!decisionPolicy.allowed && !(decisionSignup && decisionSignup.allowed)) {
    const rec = makeRecord(agent, prompt, "denied", `denied: ${decisionPolicy.reason}`, decision);
    store.addRequest(rec);
    store.audit(agent.id, "request.denied", { prompt, reason: decisionPolicy.reason });
    return { outcome: "denied", message: `denied: ${decisionPolicy.reason}`, decision };
  }
  if (decisionPolicy.requiresApproval) {
    const rec = makeRecord(agent, prompt, "pending-approval", "request requires human approval", decision);
    store.addRequest(rec);
    store.audit(agent.id, "request.pending", { prompt, policy: decisionPolicy.matched?.id });
    return { outcome: "pending-approval", message: "request requires human approval before fulfilment", decision };
  }

  // 4. Run the connector.
  const connector = getConnector(decision.serviceKey);
  const ctx: ConnectorContext = {
    org,
    service: svc,
    getSecret: (ref) => vault.get(ref),
    putSecret: (name, value) => vault.put(name, value),
    simulate: isSimulate(),
    log: (m) => store.audit(agent.id, "connector.log", { service: decision!.serviceKey, message: m }),
  };

  let result: ProvisionResult;
  try {
    result = await connector.provision(ctx, decision.action, decision.params);
  } catch (e) {
    const msg = `connector error: ${(e as Error).message}`;
    store.addRequest(makeRecord(agent, prompt, "error", msg, decision));
    return { outcome: "error", message: msg, decision };
  }
  // Persist any service mutations (e.g. captured signup keys).
  store.addService(svc);

  if (!result.ok) {
    store.addRequest(makeRecord(agent, prompt, "error", result.message, decision));
    store.audit(agent.id, "request.error", { prompt, message: result.message });
    return { outcome: "error", message: result.message, decision };
  }

  // 5. Vault the returned secrets, build the grant.
  const secretRefs: Record<string, string> = {};
  for (const [name, value] of Object.entries(result.secrets)) {
    secretRefs[name] = vault.put(`grant:${decision.serviceKey}:${name}`, value, { agent: agent.id });
  }
  const grant: Grant = {
    id: id("grt"),
    agentId: agent.id,
    serviceId: svc.id,
    serviceKey: decision.serviceKey,
    action: decision.action,
    resource: result.resource,
    secretRefs,
    scopes: result.scopes ?? [],
    status: "active",
    createdAt: nowISO(),
  };
  store.addGrant(grant);

  const rec = makeRecord(agent, prompt, "fulfilled", result.message, decision);
  rec.grantId = grant.id;
  store.addRequest(rec);
  store.audit(agent.id, "request.fulfilled", { prompt, service: decision.serviceKey, action: decision.action, grant: grant.id });

  if (svc.status === "needs-signup" || svc.status === "configured") {
    svc.status = "active";
    store.addService(svc);
  }

  return { outcome: "fulfilled", message: result.message, grant, secrets: result.secrets, resource: result.resource, decision };
}

function makeRecord(agent: RequestingAgent, prompt: string, outcome: RequestRecord["outcome"], message: string, decision?: FulfillResult["decision"]): RequestRecord {
  return { id: id("req"), agentId: agent.id, prompt, outcome, message, decision, createdAt: nowISO() };
}
