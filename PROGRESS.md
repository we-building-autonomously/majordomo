# majordomo — build progress

> **What this is:** `majordomo` is an *IT manager agent harness* (a CLI). Not a coding agent.
> A human sets it up (registers the org, a service catalog, requesting agents, and access
> policies). From then on, **other agents** connect and ask it for keys/access. The IT agent
> evaluates each request against policy and fulfils it by either (a) handing over existing
> vaulted credentials, (b) provisioning a new resource via the service's **API** (e.g. create a
> Supabase DB, buy a Twilio number), or (c) **signing up** for a brand-new service via **browser
> automation** on behalf of the org and storing the resulting keys. Inspiration: hermes / opencode
> harness shape, but the "agent" is an IT/ops manager rather than a programmer.

## Architecture (target)

```
human ──(setup: init / service / agent / policy)──▶  majordomo state + encrypted vault
                                                            │
other agent ──(request: "I need a supabase db")──▶  IT-agent brain (Claude)
                                                            │  decide service+action+params
                                                            ▼
                                                    connector (api | browser)
                                                       ├─ provision resource
                                                       └─ sign up for new service
                                                            │
                                                            ▼
                                              grant: scoped creds returned to requesting agent
                                              (audit logged; secrets stay in vault)
```

## Module map

- `src/util/crypto.ts`   — AES-256-GCM + scrypt KDF                          ✅
- `src/vault.ts`         — encrypted secret store                            ✅
- `src/store.ts`         — org/services/agents/policies/grants/audit (JSON)  ✅
- `src/types.ts`         — shared types                                      ✅
- `src/config.ts`        — paths, env, master-key resolution                 ✅
- `src/util/id.ts`,`log.ts` — ids + logging                                  ✅
- `src/catalog.ts`       — service catalog (supabase/twilio/browserbase/...) ✅
- `src/policy.ts`        — policy engine (can agent X do action Y on svc Z)  ✅
- `src/connectors/*`     — Connector interface + api/browser connectors      ✅ (api+sim) / ✅ browser driver
- `src/agent/brain.ts`   — Claude-driven request fulfilment                  ✅
- `src/agent/tools.ts`   — tool surface for the brain                        ✅
- `src/server/http.ts`   — HTTP API for agent requests                       ✅
- `src/server/mcp.ts`    — MCP (stdio) server for agent requests             ✅
- `src/commands/*`       — init/service/agent/policy/request/vault/serve/audit ✅
- `src/index.ts`         — CLI router                                        ✅

## Status — COMPLETE ✅

- [x] Iteration 1 — scaffolding, crypto, vault, store, config, `init`
- [x] Iteration 2 — catalog, `service`, `agent`, `policy`, `vault` commands
- [x] Iteration 3 — connector interface + Supabase/Twilio/Browserbase (api + simulate)
- [x] Iteration 4 — brain (Claude) + `request` command end-to-end
- [x] Iteration 5 — `serve` (HTTP + MCP) so other agents can request remotely
- [x] Iteration 6 — browser-signup connector (Playwright, Claude-guided, lazy-loaded)
- [x] Iteration 7 — audit, README, end-to-end smoke test, polish
- [x] **Pivot (per user note): UNIVERSAL agentic connector** — any free-form service works
      with no per-service code; bespoke connectors kept only as shipped accelerators.

### Verification
- `node scripts/smoke.ts` → 12/12 pass (full setup→request→grant→vault→audit flow, simulate mode).
- HTTP `serve` and MCP `serve --mcp` driven end-to-end (see git history / smoke).
- All modules load-checked via dynamic import (no syntax errors).
- **Untested here:** the real Claude-driven path + real browser sign-up — needs `ANTHROPIC_API_KEY`
  (absent in this env) and would create real third-party accounts, so only run deliberately.
  Structure is in place and the orchestration is proven via simulate mode.

## How to run (current)

```bash
cd /Users/co/majordomo
node src/index.ts --help
MAJORDOMO_SIMULATE=1 node src/index.ts init --org "Acme" --email it@acme.test
```

Simulate mode (`MAJORDOMO_SIMULATE=1`) makes connectors return realistic fake resources so the
whole flow is demonstrable with no real accounts/network. Drop it to make real API/browser calls.

## Notes / decisions

- Native TS execution (Node ≥23 type-stripping) → no build step. Erasable-only syntax
  (no enums, no parameter properties, `import type` for types).
- Zero hard deps for setup commands. `@anthropic-ai/sdk` lazy-loaded for brain/serve.
  `playwright` optional, lazy-loaded for browser signup.
