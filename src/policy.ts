// Policy engine: decide whether a requesting agent may perform an action on a service.
import type { Store } from "./store.ts";
import type { Policy, PolicyAction, RequestingAgent } from "./types.ts";

export type PolicyDecision = {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  matched?: Policy;
};

function actionMatches(p: Policy, action: PolicyAction): boolean {
  return p.actions.includes("*") || p.actions.includes(action);
}

/** Evaluate the most specific matching policy. Specific agent+service beats wildcards. */
export function evaluate(
  store: Store,
  agent: RequestingAgent,
  serviceKey: string,
  action: PolicyAction,
): PolicyDecision {
  const candidates = store.policies().filter((p) => {
    const agentOk = p.agentId === "*" || p.agentId === agent.id;
    const svcOk = p.serviceKey === "*" || p.serviceKey === serviceKey;
    return agentOk && svcOk && actionMatches(p, action);
  });

  if (candidates.length === 0) {
    return { allowed: false, requiresApproval: false, reason: `no policy permits ${action} on ${serviceKey} for ${agent.name}` };
  }

  // Specificity score: exact agent (2) + exact service (2) + non-wildcard action (1).
  const scored = candidates
    .map((p) => ({
      p,
      score: (p.agentId !== "*" ? 2 : 0) + (p.serviceKey !== "*" ? 2 : 0) + (!p.actions.includes("*") ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0].p;

  // Enforce maxGrants on the winning policy.
  if (best.maxGrants > 0) {
    const live = store.grantsFor(agent.id, serviceKey === "*" ? undefined : serviceKey).length;
    if (live >= best.maxGrants) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `grant limit reached (${live}/${best.maxGrants}) for policy ${best.id}`,
        matched: best,
      };
    }
  }

  return {
    allowed: true,
    requiresApproval: best.requiresApproval,
    reason: best.requiresApproval ? `permitted but requires human approval (policy ${best.id})` : `permitted by policy ${best.id}`,
    matched: best,
  };
}
