// Fallback connector for catalog entries without a bespoke implementation.
// In simulate mode it returns a plausible API key; otherwise it reports that a
// bespoke connector or root secret is required.
import type { Connector, ConnectorContext, ProvisionResult } from "../types.ts";
import { randomToken } from "../util/crypto.ts";

export function genericConnector(key: string): Connector {
  return {
    key,
    mode: "api",
    capabilities: [],
    async provision(ctx: ConnectorContext, action: string): Promise<ProvisionResult> {
      if (ctx.simulate) {
        return {
          ok: true,
          resource: { service: key, action },
          secrets: { api_key: `${key}_${randomToken(20)}` },
          scopes: ["api:default"],
          message: `[simulate] issued ${key} credentials for "${action}".`,
        };
      }
      // Try to hand back an existing root key if one is configured.
      const firstRef = Object.values(ctx.service.rootSecretRefs)[0];
      const existing = firstRef ? ctx.getSecret(firstRef) : undefined;
      if (existing) {
        return {
          ok: true,
          resource: { service: key, action, note: "returned configured root key" },
          secrets: { api_key: existing },
          scopes: ["api:default"],
          message: `Returned configured ${key} key.`,
        };
      }
      return { ok: false, resource: {}, secrets: {}, message: `no connector implementation for ${key} and no configured key — add one or use simulate mode` };
    },
  };
}
