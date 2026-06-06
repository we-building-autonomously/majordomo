// Twilio connector — buys numbers / mints API keys via the REST API.
import type { Connector, ConnectorContext, ProvisionResult } from "../types.ts";
import { randomToken } from "../util/crypto.ts";

const API = "https://api.twilio.com/2010-04-01";

function basicAuth(sid: string, token: string): string {
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

async function buyNumber(ctx: ConnectorContext, params: Record<string, unknown>): Promise<ProvisionResult> {
  const country = String(params.country || "US");
  const areaCode = params.area_code ? String(params.area_code) : undefined;

  if (ctx.simulate) {
    const ac = areaCode || ["415", "628", "212", "646", "305"][Math.floor((Date.now() / 1000) % 5)];
    const number = `+1${ac}${String(1000000 + (Date.now() % 9000000)).slice(0, 7)}`;
    const sid = `PN${randomToken(16).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`;
    ctx.log(`[simulate] purchased Twilio number ${number} (${sid})`);
    return {
      ok: true,
      resource: { phone_number: number, sid, country, capabilities: String(params.capabilities || "sms,voice") },
      secrets: { phone_number: number, phone_sid: sid },
      scopes: ["sms:send", "voice:call"],
      message: `Purchased phone number ${number}.`,
    };
  }

  const sid = ctx.getSecret(ctx.service.rootSecretRefs["account_sid"] ?? "");
  const auth = ctx.getSecret(ctx.service.rootSecretRefs["auth_token"] ?? "");
  if (!sid || !auth) return { ok: false, resource: {}, secrets: {}, message: "missing Twilio account_sid/auth_token" };

  // Find an available number.
  const searchUrl = new URL(`${API}/Accounts/${sid}/AvailablePhoneNumbers/${country}/Local.json`);
  searchUrl.searchParams.set("SmsEnabled", "true");
  if (areaCode) searchUrl.searchParams.set("AreaCode", areaCode);
  const search = await fetch(searchUrl, { headers: { Authorization: basicAuth(sid, auth) } });
  if (!search.ok) return { ok: false, resource: {}, secrets: {}, message: `Twilio search error ${search.status}` };
  const avail = (await search.json()) as { available_phone_numbers: { phone_number: string }[] };
  const pick = avail.available_phone_numbers?.[0]?.phone_number;
  if (!pick) return { ok: false, resource: {}, secrets: {}, message: "no available numbers matched" };

  const body = new URLSearchParams({ PhoneNumber: pick });
  const buy = await fetch(`${API}/Accounts/${sid}/IncomingPhoneNumbers.json`, {
    method: "POST",
    headers: { Authorization: basicAuth(sid, auth), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!buy.ok) return { ok: false, resource: {}, secrets: {}, message: `Twilio purchase error ${buy.status}: ${await buy.text()}` };
  const bought = (await buy.json()) as { sid: string; phone_number: string };
  return {
    ok: true,
    resource: { phone_number: bought.phone_number, sid: bought.sid, country },
    secrets: { phone_number: bought.phone_number, phone_sid: bought.sid },
    scopes: ["sms:send", "voice:call"],
    message: `Purchased ${bought.phone_number}.`,
  };
}

async function createApiKey(ctx: ConnectorContext, params: Record<string, unknown>): Promise<ProvisionResult> {
  const friendly = String(params.friendly_name || "majordomo");
  if (ctx.simulate) {
    const keySid = `SK${randomToken(16).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`;
    return {
      ok: true,
      resource: { key_sid: keySid, friendly_name: friendly },
      secrets: { api_key_sid: keySid, api_key_secret: randomToken(24) },
      scopes: ["api:full"],
      message: `Created Twilio API key "${friendly}".`,
    };
  }
  const sid = ctx.getSecret(ctx.service.rootSecretRefs["account_sid"] ?? "");
  const auth = ctx.getSecret(ctx.service.rootSecretRefs["auth_token"] ?? "");
  if (!sid || !auth) return { ok: false, resource: {}, secrets: {}, message: "missing Twilio creds" };
  const res = await fetch(`${API}/Accounts/${sid}/Keys.json`, {
    method: "POST",
    headers: { Authorization: basicAuth(sid, auth), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ FriendlyName: friendly }),
  });
  if (!res.ok) return { ok: false, resource: {}, secrets: {}, message: `Twilio key error ${res.status}` };
  const key = (await res.json()) as { sid: string; secret: string };
  return { ok: true, resource: { key_sid: key.sid }, secrets: { api_key_sid: key.sid, api_key_secret: key.secret }, scopes: ["api:full"], message: "Created API key." };
}

export const twilioConnector: Connector = {
  key: "twilio",
  mode: "api",
  capabilities: [],
  async provision(ctx, action, params) {
    if (action === "buy_number") return buyNumber(ctx, params);
    if (action === "create_api_key") return createApiKey(ctx, params);
    return { ok: false, resource: {}, secrets: {}, message: `unsupported twilio action: ${action}` };
  },
};
