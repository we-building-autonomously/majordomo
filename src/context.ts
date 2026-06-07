// Loads the store + unlocks the vault for a command. Resolves the master key from
// MAJORDOMO_MASTER_KEY or an interactive hidden prompt.
import { Store } from "./store.ts";
import { Vault } from "./vault.ts";
import { masterKeyFromEnv } from "./config.ts";
import { askHidden } from "./util/prompt.ts";

export type Ctx = { store: Store; vault: Vault };

async function resolveMasterKey(): Promise<string> {
  const fromEnv = masterKeyFromEnv();
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error("master key required: set MAJORDOMO_MASTER_KEY (no TTY for prompt)");
  }
  return askHidden("Master key");
}

/** Open store + vault, unlocking with the master key. */
export async function loadCtx(): Promise<Ctx> {
  if (!Vault.exists()) throw new Error("not initialized — run `it init` first");
  const key = await resolveMasterKey();
  const vault = Vault.open(key); // throws on wrong key
  const store = Store.load();
  return { store, vault };
}

/** Like loadCtx but used by `serve` etc. where the key must be in env. */
export async function loadCtxUnattended(): Promise<Ctx> {
  return loadCtx();
}
