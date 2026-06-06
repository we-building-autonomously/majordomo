// Claude-guided browser signup driver. Lazy-loads Playwright (optional dep).
//
// Given a signup URL and the details to register with, it drives a real browser:
// it screenshots / reads the DOM, asks Claude what to do next (fill field, click,
// solve a step), and loops until it reaches a dashboard / API-keys page or gives up.
// In simulate mode it never launches a browser — it fabricates a plausible account.
//
// This is the "sign up for a service on behalf of the org" capability.
import type { ConnectorContext, SignupResult } from "../types.ts";
import { randomToken } from "../util/crypto.ts";
import { callClaudeTools } from "../agent/llm.ts";

export type SignupSpec = {
  serviceName: string;
  signupUrl: string;
  /** What we expect to capture once signed in. */
  wantSecrets: string[];
  /** Registration details to use. */
  account: { email: string; password: string; orgName: string };
};

/** Simulate-mode signup: no browser, fabricate creds. */
function simulatedSignup(spec: SignupSpec, ctx: ConnectorContext): SignupResult {
  ctx.log(`[simulate] signed up for ${spec.serviceName} as ${spec.account.email}`);
  const rootSecrets: Record<string, string> = {};
  for (const name of spec.wantSecrets) {
    rootSecrets[name] = name.includes("project") || name.includes("id")
      ? `${spec.serviceName.toLowerCase()}_${randomToken(6)}`
      : `${spec.serviceName.toLowerCase()}_${randomToken(20)}`;
  }
  return {
    ok: true,
    account: { email: spec.account.email, orgId: `org_${randomToken(5)}`, dashboardUrl: `https://${spec.serviceName.toLowerCase()}.com/dashboard` },
    rootSecrets,
    message: `[simulate] created ${spec.serviceName} account and captured ${spec.wantSecrets.join(", ")}.`,
  };
}

/**
 * Real browser signup. Returns ok:false with a helpful message if Playwright
 * isn't installed or ANTHROPIC_API_KEY is missing — the caller can fall back.
 */
async function realSignup(spec: SignupSpec, ctx: ConnectorContext): Promise<SignupResult> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return { ok: false, account: {}, rootSecrets: {}, message: "playwright not installed — run `npm i playwright && npx playwright install chromium`, or use MAJORDOMO_SIMULATE=1" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, account: {}, rootSecrets: {}, message: "ANTHROPIC_API_KEY required for browser-guided signup" };
  }

  const browser = await chromium.launch({ headless: process.env.MAJORDOMO_HEADFUL ? false : true });
  const captured: Record<string, string> = {};
  try {
    const page = await browser.newPage();
    await page.goto(spec.signupUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    const maxSteps = 18;
    for (let step = 0; step < maxSteps; step++) {
      const dom = await summarizeDom(page);
      const decision = await nextAction(spec, dom, captured);
      ctx.log(`signup step ${step + 1}: ${decision.action} ${decision.selector ?? ""} ${decision.note ?? ""}`);

      if (decision.action === "done") break;
      if (decision.action === "give_up") {
        return { ok: false, account: {}, rootSecrets: captured, message: `signup could not be completed automatically: ${decision.note ?? ""}` };
      }
      try {
        await applyAction(page, decision);
        if (decision.capture) for (const [k, v] of Object.entries(decision.capture)) captured[k] = v;
        await page.waitForTimeout(900);
      } catch (e) {
        ctx.log(`  action failed: ${(e as Error).message}`);
      }
    }

    return {
      ok: Object.keys(captured).length > 0,
      account: { email: spec.account.email, dashboardUrl: page.url() },
      rootSecrets: captured,
      message: Object.keys(captured).length ? `Signed up and captured ${Object.keys(captured).join(", ")}.` : "Signup flow finished but no secrets captured.",
    };
  } catch (e) {
    return { ok: false, account: {}, rootSecrets: captured, message: `browser signup error: ${(e as Error).message}` };
  } finally {
    await browser.close();
  }
}

type Action = {
  action: "goto" | "fill" | "click" | "press" | "capture_text" | "done" | "give_up";
  selector?: string;
  value?: string;
  url?: string;
  capture?: Record<string, string>;
  note?: string;
};

async function summarizeDom(page: import("playwright").Page): Promise<string> {
  // Compact, model-friendly view of interactive elements + visible text.
  return page.evaluate(() => {
    const out: string[] = [];
    const sel = (el: Element) => {
      const id = (el as HTMLElement).id;
      if (id) return `#${id}`;
      const name = el.getAttribute("name");
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      const ph = el.getAttribute("placeholder");
      if (ph) return `${el.tagName.toLowerCase()}[placeholder="${ph}"]`;
      const t = el.getAttribute("type");
      return t ? `${el.tagName.toLowerCase()}[type="${t}"]` : el.tagName.toLowerCase();
    };
    document.querySelectorAll("input,button,a[href],textarea,select").forEach((el) => {
      const e = el as HTMLElement;
      if (e.offsetParent === null && e.tagName !== "INPUT") return;
      const label = (e.innerText || e.getAttribute("aria-label") || e.getAttribute("value") || e.getAttribute("placeholder") || "").trim().slice(0, 60);
      out.push(`${e.tagName.toLowerCase()} ${sel(e)} :: ${label}`);
    });
    const bodyText = (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 1200);
    return `URL: ${location.href}\nTEXT: ${bodyText}\nELEMENTS:\n${out.slice(0, 60).join("\n")}`;
  });
}

const ACTION_TOOL = {
  name: "browser_action",
  description: "Decide the single next browser action to progress a signup, or finish.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["goto", "fill", "click", "press", "capture_text", "done", "give_up"] },
      selector: { type: "string", description: "CSS selector for fill/click/capture_text" },
      value: { type: "string", description: "Value to fill, key to press, or capture key name" },
      url: { type: "string", description: "URL for goto" },
      note: { type: "string", description: "Short reasoning / status" },
    },
    required: ["action"],
  },
} as const;

async function nextAction(spec: SignupSpec, dom: string, captured: Record<string, string>): Promise<Action> {
  const system = `You are an IT operations agent signing up for ${spec.serviceName} on behalf of an organization.
Goal: complete account registration and reach the page showing API keys / project credentials, capturing: ${spec.wantSecrets.join(", ")}.
Registration details — email: ${spec.account.email}, password: ${spec.account.password}, org/name: ${spec.account.orgName}.
Rules: choose ONE next action via the browser_action tool. Prefer email/password signup over OAuth. To record a credential visible on the page, use capture_text with selector=the element and value=the secret name. When all wanted secrets are captured or you reach the dashboard, use action=done. If blocked (captcha, email verification, payment wall), use give_up with a note. Already captured: ${Object.keys(captured).join(", ") || "none"}.`;

  const res = await callClaudeTools({
    system,
    messages: [{ role: "user", content: `Current page:\n${dom}\n\nWhat is the single next action?` }],
    tools: [ACTION_TOOL],
    toolChoice: { type: "tool", name: "browser_action" },
    maxTokens: 600,
  });
  const call = res.toolCalls[0];
  if (!call) return { action: "give_up", note: "model returned no action" };
  return call.input as Action;
}

async function applyAction(page: import("playwright").Page, a: Action): Promise<void> {
  switch (a.action) {
    case "goto": if (a.url) await page.goto(a.url, { waitUntil: "domcontentloaded" }); break;
    case "fill": if (a.selector) await page.fill(a.selector, a.value ?? ""); break;
    case "click": if (a.selector) await page.click(a.selector, { timeout: 8000 }); break;
    case "press": if (a.selector) await page.press(a.selector, a.value || "Enter"); break;
    case "capture_text":
      if (a.selector && a.value) {
        const txt = (await page.textContent(a.selector))?.trim() || (await page.inputValue(a.selector).catch(() => "")) || "";
        if (txt) a.capture = { ...(a.capture ?? {}), [a.value]: txt };
      }
      break;
  }
}

/** Public entry: sign up for a service, honoring simulate mode. */
export async function browserSignup(spec: SignupSpec, ctx: ConnectorContext): Promise<SignupResult> {
  if (ctx.simulate) return simulatedSignup(spec, ctx);
  return realSignup(spec, ctx);
}
