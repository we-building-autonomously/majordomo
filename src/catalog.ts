// The catalog of services majordomo knows how to manage. Each entry is a template;
// `service add <key>` instantiates one for the org. Capabilities describe what the
// IT agent can provision; the brain maps a natural-language request onto one.
import type { CatalogEntry } from "./types.ts";

export const CATALOG: Record<string, CatalogEntry> = {
  supabase: {
    key: "supabase",
    displayName: "Supabase",
    homepage: "https://supabase.com",
    signupUrl: "https://supabase.com/dashboard/sign-up",
    docsUrl: "https://supabase.com/docs/reference/api",
    mode: "api",
    rootSecrets: [
      { name: "access_token", label: "Personal access token", help: "Supabase account access token (sbp_...) from https://supabase.com/dashboard/account/tokens" },
      { name: "organization_id", label: "Organization id", help: "Target Supabase org id for new projects" },
    ],
    capabilities: [
      {
        action: "create_project",
        title: "Create a Postgres database / project",
        description: "Spin up a new Supabase project (managed Postgres + auth + storage) and return its connection string and API keys.",
        params: {
          name: { type: "string", description: "Project name", required: true },
          region: { type: "string", description: "Region, e.g. us-east-1", default: "us-east-1" },
          plan: { type: "string", description: "Billing plan", default: "free" },
        },
      },
      {
        action: "create_api_key",
        title: "Issue a scoped API key",
        description: "Return the anon/service API keys for an existing project.",
        params: { project_ref: { type: "string", description: "Project ref", required: true } },
      },
    ],
    tags: ["database", "postgres", "backend"],
  },

  twilio: {
    key: "twilio",
    displayName: "Twilio",
    homepage: "https://twilio.com",
    signupUrl: "https://www.twilio.com/try-twilio",
    docsUrl: "https://www.twilio.com/docs/usage/api",
    mode: "api",
    rootSecrets: [
      { name: "account_sid", label: "Account SID", help: "Twilio Account SID (AC...)" },
      { name: "auth_token", label: "Auth token", help: "Twilio auth token from the console" },
    ],
    capabilities: [
      {
        action: "buy_number",
        title: "Buy a phone number",
        description: "Search and purchase a phone number (SMS/voice capable) and return its SID and E.164 number.",
        params: {
          country: { type: "string", description: "ISO country code", default: "US" },
          area_code: { type: "string", description: "Preferred area code", required: false },
          capabilities: { type: "string", description: "Comma list: sms,voice,mms", default: "sms,voice" },
        },
      },
      {
        action: "create_api_key",
        title: "Create a scoped API key",
        description: "Create a Twilio API key/secret pair for programmatic access.",
        params: { friendly_name: { type: "string", description: "Key name", default: "majordomo" } },
      },
    ],
    tags: ["telephony", "sms", "voice"],
  },

  browserbase: {
    key: "browserbase",
    displayName: "Browserbase",
    homepage: "https://browserbase.com",
    signupUrl: "https://www.browserbase.com/sign-up",
    docsUrl: "https://docs.browserbase.com",
    mode: "browser", // no self-serve signup API → demonstrate browser signup
    rootSecrets: [
      { name: "api_key", label: "API key", help: "Browserbase API key from the dashboard" },
      { name: "project_id", label: "Project id", help: "Browserbase project id" },
    ],
    capabilities: [
      {
        action: "issue_keys",
        title: "Provision Browserbase API access",
        description: "Sign up (if needed) and return a Browserbase API key + project id for headless browser sessions.",
        params: {},
      },
      {
        action: "create_session",
        title: "Start a browser session",
        description: "Create a Browserbase headless browser session and return its connect URL.",
        params: { project_id: { type: "string", description: "Project id", required: false } },
      },
    ],
    tags: ["browser", "automation", "headless"],
  },

  openai: {
    key: "openai",
    displayName: "OpenAI",
    homepage: "https://openai.com",
    signupUrl: "https://platform.openai.com/signup",
    docsUrl: "https://platform.openai.com/docs",
    mode: "browser",
    rootSecrets: [{ name: "admin_key", label: "Admin API key", help: "OpenAI org admin key for minting project keys" }],
    capabilities: [
      {
        action: "issue_key",
        title: "Mint a project API key",
        description: "Create a scoped OpenAI API key for a requesting agent.",
        params: { project: { type: "string", description: "Project name", default: "default" } },
      },
    ],
    tags: ["llm", "ai"],
  },

  resend: {
    key: "resend",
    displayName: "Resend",
    homepage: "https://resend.com",
    signupUrl: "https://resend.com/signup",
    docsUrl: "https://resend.com/docs",
    mode: "api",
    rootSecrets: [{ name: "api_key", label: "API key", help: "Resend account API key (re_...)" }],
    capabilities: [
      {
        action: "issue_key",
        title: "Create a sending API key",
        description: "Create a Resend API key scoped to sending and return it.",
        params: { name: { type: "string", description: "Key name", default: "majordomo" } },
      },
    ],
    tags: ["email"],
  },
};

export function catalogEntry(key: string): CatalogEntry | undefined {
  return CATALOG[key.toLowerCase()];
}

export function catalogKeys(): string[] {
  return Object.keys(CATALOG);
}
