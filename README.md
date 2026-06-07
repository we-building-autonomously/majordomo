# majordomo &nbsp;·&nbsp; `@run-agents/it`

> `npm i -g @run-agents/it` → the **`it`** command.

**An IT-manager agent — as a CLI.** Not a coding agent: majordomo is the agent that *manages
access to services for an organization*. A human sets it up once (registers the org, the services
to manage, the agents that may ask, and the access policies). From then on, **other agents** connect
and ask — in plain language — for keys and resources. majordomo decides what to do, **provisions it
(via API or by signing up through a real browser on the org's behalf)**, stores the secrets in an
encrypted vault, and hands scoped credentials back to the requesting agent.

```
  human ──set up──▶  majordomo  ◀──"I need a postgres db"──  other agent
                        │
              decide service + action (Claude)
                        │
         ┌──────────────┴───────────────┐
     API call                       browser sign-up
   (provision a resource)       (create an account, grab keys)
         └──────────────┬───────────────┘
                        ▼
            scoped credentials  ──▶  requesting agent
            (secrets stay vaulted · every action audited)
```

It draws its harness shape from coding agents like hermes / opencode — a CLI with an agent loop and
tools — but the agent is an **IT/ops manager**, and its "tools" provision infrastructure.

---

## Why one universal connector

majordomo does **not** want a hand-written integration per service. There is a single
**universal agentic connector**: given *any* service (a name plus whatever URLs you have), the IT
agent signs up and provisions resources itself using three primitives — an authenticated
`http_request` tool, a docs reader, and the Claude-guided browser driver — looping until it captures
the credentials. So you can point majordomo at a service it has never seen:

```bash
it service add pinecone --signup-url https://app.pinecone.io/signup --docs https://docs.pinecone.io
```

A few **bespoke accelerators** ship with the harness (Supabase, Twilio, Browserbase) as fast,
deterministic paths — these are the harness's own integrations, not something you have to write.
Force the universal path for everything with `MAJORDOMO_GENERIC=1`.

---

## Install / run

```bash
npm install -g @run-agents/it      # installs the `it` command
it --help

# or run without installing:
npx @run-agents/it --help

# for real browser sign-ups: npm i -g playwright && npx playwright install chromium
```

Requires Node ≥ 20. From a checkout, `npm run build && node dist/index.js --help` (or `node src/index.ts` on Node ≥ 23.6).

## Quick start (60 seconds, no accounts needed)

`MAJORDOMO_SIMULATE=1` makes connectors return realistic **fake** resources, so you can see the whole
flow with no real accounts, network, or API key. Drop it to do the real thing.

```bash
export MAJORDOMO_SIMULATE=1
export MAJORDOMO_MASTER_KEY=choose-a-strong-key      # unlocks the vault non-interactively

# 1. human sets things up
it init --org "Acme Inc" --email it@acme.test
it service add supabase --defer        # a catalog accelerator
it service add pinecone \               # ANY service, free-form
     --signup-url https://app.pinecone.io/signup --secrets api_key --defer
it agent add deploy-bot                 # prints a bearer token — copy it
it policy allow deploy-bot "*" provision signup

# 2. an agent asks for what it needs
it request --as <token> "I need a postgres database called orders"
it request --as <token> "give me a pinecone api key"

# 3. the human reviews
it grants
it audit
```

---

## How a request is handled

1. **Authenticate** the requesting agent by its bearer token.
2. **Decide** which service + action + parameters the request maps to (Claude tool-call; a keyword
   heuristic is used when `ANTHROPIC_API_KEY` is absent).
3. **Authorize** against policy — which agents may `provision` / `signup` / `read` which services,
   with optional grant caps and human-approval gates.
4. **Fulfil** via the connector: hand over an existing key, call the service API, or **sign up via
   browser** and capture the keys.
5. **Vault + grant**: secrets are encrypted; a scoped grant is returned to the agent; everything is
   audited.

---

## Commands

### Setup (human)
| command | description |
|---|---|
| `init` | create the org + encrypted vault (+ master key) |
| `service catalog` | list built-in accelerator presets |
| `service add <name>` | register a service — a preset, or free-form with `--signup-url/--api-base/--docs/--secrets` |
| `service set-secret <svc> <name> <value>` | add a root/admin secret later |
| `service list` / `service show <svc>` | inspect services |
| `agent add <name>` | register a requesting agent → prints a one-time bearer token |
| `agent list` / `rotate` / `disable` / `enable` | manage agents |
| `policy allow <agent\|*> <service\|*> <actions...>` | grant access. actions: `read provision signup *`; `--max N`, `--approve` |
| `policy list` / `remove <id>` | manage policies |

### Runtime (agents)
| command | description |
|---|---|
| `request --as <token> "..."` | request access/resource in natural language (`--json` for machine output) |
| `serve` | HTTP API on `127.0.0.1:8787` for remote agents |
| `serve --http host:port` | custom bind address |
| `serve --mcp` | MCP server over stdio (for MCP-speaking agents) |

### Review
| command | description |
|---|---|
| `grants [--agent <name>]` · `revoke <grant-id>` | list / revoke issued grants |
| `audit [-n N]` | audit log |
| `vault list [--reveal]` · `vault get <ref>` | inspect the encrypted vault |

---

## Serving other agents

**HTTP**
```bash
MAJORDOMO_MASTER_KEY=… it serve --http 127.0.0.1:8787 &
curl -s -X POST http://127.0.0.1:8787/request \
  -H "Authorization: Bearer <agent-token>" \
  -d '{"prompt":"buy a phone number with area code 415"}'
# also: GET /capabilities, GET /grants, GET /health
```

**MCP** (drop into any MCP client config — Claude Desktop, etc.):
```json
{
  "mcpServers": {
    "majordomo": {
      "command": "node",
      "args": ["/path/to/majordomo/src/index.ts", "serve", "--mcp"],
      "env": { "MAJORDOMO_MASTER_KEY": "…", "MAJORDOMO_AGENT_TOKEN": "mjd_…" }
    }
  }
}
```
Exposes tools: `request_access`, `list_services`, `my_grants`.

---

## Security model

- **Vault**: AES-256-GCM, key derived via scrypt from the master key. Secret *values* never touch
  `state.json` — only references do. `vault list` masks values unless `--reveal`.
- **Secrets stay out of the model**: the universal connector references root secrets as
  `{{secret:NAME}}` placeholders that are substituted only when the HTTP request leaves the process —
  the LLM never sees the raw value.
- **Least privilege**: policies scope each agent to specific services/actions, with grant caps and
  optional human approval. Tokens are stored hashed (sha256) and shown once.
- **Auditable**: every decision, provisioning step, and grant is recorded.

## Environment

| var | purpose |
|---|---|
| `MAJORDOMO_MASTER_KEY` | unlock the vault non-interactively (required for `serve`) |
| `MAJORDOMO_SIMULATE=1` | fake provisioning — no real accounts/network/LLM |
| `ANTHROPIC_API_KEY` | the IT-agent brain + Claude-guided browser sign-up |
| `MAJORDOMO_MODEL` | override the model (default `claude-opus-4-8`) |
| `MAJORDOMO_GENERIC=1` | force the universal connector even where an accelerator exists |
| `MAJORDOMO_HOME` | data directory (default `~/.majordomo`) |
| `MAJORDOMO_HEADFUL=1` | show the browser during sign-up (debugging) |

## Layout

```
src/
  index.ts            CLI router
  config.ts types.ts  config + shared types
  vault.ts store.ts   encrypted secrets + plaintext state
  catalog.ts          accelerator presets (optional)
  policy.ts           access-policy engine
  agent/
    brain.ts          request → service+action → policy → connector → grant
    llm.ts            Anthropic SDK wrapper + agentic tool loop
  connectors/
    agentic.ts        the UNIVERSAL connector (any service)
    browser.ts        Claude-guided Playwright sign-up driver
    supabase/twilio/browserbase.ts   shipped accelerators
  server/http.ts mcp.ts   remote access for other agents
  commands/*          one file per CLI command
scripts/smoke.ts      end-to-end test
```

MIT.
