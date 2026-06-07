// `it init` — one-time setup performed by a human. Creates the org,
// the encrypted vault, and the master key, then prints next steps.
import { Store } from "../store.ts";
import { Vault } from "../vault.ts";
import { dataDir } from "../config.ts";
import { slugify, nowISO } from "../util/id.ts";
import { ask, askHidden } from "../util/prompt.ts";
import { parseArgs, str } from "../util/args.ts";
import { log, color } from "../util/log.ts";
import { randomToken } from "../util/crypto.ts";
import type { Org } from "../types.ts";

export async function cmdInit(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);

  if (Vault.exists()) {
    log.warn(`already initialized at ${color.bold(dataDir())}`);
    log.detail("delete that directory (or set MAJORDOMO_HOME) to start fresh");
    return;
  }

  log.info(color.bold("\n  majordomo — IT manager agent setup\n"));

  const name = str(flags, "org") || (await ask("Organization name", "Acme Inc"));
  const email = str(flags, "email") || (await ask("IT contact email", `it@${slugify(name)}.com`));

  // Master key: from flag, env, prompt, or auto-generate.
  let master = str(flags, "master-key") || process.env.MAJORDOMO_MASTER_KEY || "";
  let generated = false;
  if (!master) {
    if (process.stdin.isTTY && !flags["generate-key"]) {
      master = await askHidden("Choose a master key (encrypts the vault)");
      const again = await askHidden("Confirm master key");
      if (master !== again) {
        log.err("master keys did not match");
        process.exit(1);
      }
    }
    if (!master) {
      master = randomToken(24);
      generated = true;
    }
  }

  const org: Org = { name, slug: slugify(name), contactEmail: email, createdAt: nowISO() };

  Vault.create(master);
  const store = Store.load();
  store.setOrg(org);
  store.audit("human", "init", { org: org.slug, email });

  log.ok(`initialized at ${color.bold(dataDir())}`);
  log.detail(`org: ${org.name} <${org.contactEmail}>`);
  log.detail(`vault: AES-256-GCM, scrypt-derived key`);

  if (generated) {
    log.info("");
    log.warn("a master key was generated — store it now, it will not be shown again:");
    log.info(`\n    ${color.bold(color.yellow(master))}\n`);
    log.detail("export MAJORDOMO_MASTER_KEY=… to run unattended (serve, request)");
  }

  log.info(color.bold("\n  next steps:"));
  log.detail("it service add supabase      # register a service to manage");
  log.detail("it agent add my-bot          # register a requesting agent (prints a token)");
  log.detail('it policy allow my-bot supabase provision');
  log.detail('it request --as <token> "I need a postgres database"');
  log.detail("it serve                     # expose HTTP + MCP for other agents");
  log.info("");
}
