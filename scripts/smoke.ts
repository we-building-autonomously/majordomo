// End-to-end smoke test. Runs the whole harness in a throwaway home, simulate mode,
// no network / no API key. Exits non-zero on failure.  Run:  node scripts/smoke.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "mjd-smoke-"));
const CLI = join(import.meta.dirname, "..", "src", "index.ts");
const env = { ...process.env, MAJORDOMO_HOME: HOME, MAJORDOMO_MASTER_KEY: "smoke-key", MAJORDOMO_SIMULATE: "1", NO_COLOR: "1" };

let pass = 0;
let fail = 0;
function mjd(args: string[]): string {
  return execFileSync("node", [CLI, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

try {
  console.log("majordomo smoke test\n");

  check("init", mjd(["init", "--org", "Acme", "--email", "it@acme.test"]).includes("initialized"));

  // catalog service
  mjd(["service", "add", "supabase", "--defer"]);
  // free-form service NOT in the catalog → universal connector
  mjd(["service", "add", "pinecone", "--signup-url", "https://app.pinecone.io/signup", "--secrets", "api_key", "--defer"]);
  check("two services registered", (mjd(["service", "list"]).match(/svc_/g) || []).length === 2);

  const agentOut = mjd(["agent", "add", "bot"]);
  const token = agentOut.match(/mjd_[A-Za-z0-9_-]+/)?.[0] ?? "";
  check("agent token issued", token.startsWith("mjd_"));

  // policy: no grant yet → denied
  const denied = mjd(["request", "--as", token, "I need a postgres database", "--json"]);
  check("request denied without policy", JSON.parse(denied).outcome === "denied", denied);

  mjd(["policy", "allow", "bot", "*", "provision", "signup"]);

  // catalog (bespoke) path
  const sup = JSON.parse(mjd(["request", "--as", token, "I need a postgres database called orders", "--json"]));
  check("supabase provisioned", sup.outcome === "fulfilled" && !!sup.secrets?.database_url, JSON.stringify(sup));
  check("resource named from prompt", sup.resource?.name === "orders");

  // universal connector path (free-form service)
  const pc = JSON.parse(mjd(["request", "--as", token, "give me a pinecone api key", "--json"]));
  check("free-form service provisioned via universal connector", pc.outcome === "fulfilled" && !!pc.secrets?.api_key, JSON.stringify(pc));

  // grants + audit + vault
  check("grant recorded", (mjd(["grants"]).match(/grt_/g) || []).length >= 2);
  check("audit has fulfilment", mjd(["audit"]).includes("request.fulfilled"));
  check("secrets vaulted (hidden by default)", mjd(["vault", "list"]).includes("••••"));
  check("vault reveal shows db url", mjd(["vault", "list", "--reveal"]).includes("postgresql://"));

  // unknown token rejected (exits non-zero by design → capture stdout/stderr)
  let badOut = "";
  try { badOut = mjd(["request", "--as", "mjd_not_a_real_token", "anything", "--json"]); }
  catch (e) { const err = e as { stdout?: string; stderr?: string }; badOut = (err.stdout ?? "") + (err.stderr ?? ""); }
  check("bad token rejected", badOut.includes("invalid"), badOut);

  console.log(`\n${fail === 0 ? "✓ all" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error("smoke crashed:", (e as Error).message);
  fail++;
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

process.exit(fail === 0 ? 0 : 1);
