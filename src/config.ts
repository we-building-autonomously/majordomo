import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

/** Root data dir. Override with MAJORDOMO_HOME. */
export function dataDir(): string {
  const dir = process.env.MAJORDOMO_HOME || join(homedir(), ".majordomo");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function storePath(): string {
  return join(dataDir(), "state.json");
}

export function vaultPath(): string {
  return join(dataDir(), "vault.enc");
}

export function masterKeyMetaPath(): string {
  return join(dataDir(), "master.json");
}

/** Is the IT agent in simulate mode (fake provisioning, no real network/accounts)? */
export function isSimulate(): boolean {
  return process.env.MAJORDOMO_SIMULATE === "1" || process.env.MAJORDOMO_SIMULATE === "true";
}

/**
 * Resolve the vault master passphrase. Order:
 *  1. MAJORDOMO_MASTER_KEY env (for unattended `serve`)
 *  2. interactive prompt (handled by caller)
 * Returns undefined if not in env.
 */
export function masterKeyFromEnv(): string | undefined {
  return process.env.MAJORDOMO_MASTER_KEY || undefined;
}

export function anthropicKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || undefined;
}
