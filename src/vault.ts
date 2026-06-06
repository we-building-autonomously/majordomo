// Encrypted secret store. The whole vault is one AES-256-GCM blob keyed off the
// master passphrase. Secrets are addressed by ref (sec_xxx). Plaintext values
// never touch state.json — only refs do.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { vaultPath, masterKeyMetaPath } from "./config.ts";
import { encrypt, decrypt, deriveKey, sha256 } from "./util/crypto.ts";
import type { EncBlob } from "./util/crypto.ts";
import { id, nowISO } from "./util/id.ts";
import { randomBytes } from "node:crypto";

type SecretEntry = { value: string; createdAt: string; meta?: Record<string, unknown> };
type VaultData = { version: 1; secrets: Record<string, SecretEntry> };

/** A loaded, decrypted vault held in memory for the duration of a command. */
export class Vault {
  private data: VaultData;
  private passphrase: string;

  private constructor(data: VaultData, passphrase: string) {
    this.data = data;
    this.passphrase = passphrase;
  }

  /** Create a brand-new vault, verifying the passphrase round-trips. */
  static create(passphrase: string): Vault {
    const data: VaultData = { version: 1, secrets: {} };
    const v = new Vault(data, passphrase);
    v.save();
    // Write a verifier so we can detect wrong passphrases on open.
    const salt = randomBytes(16).toString("base64");
    const check = sha256(deriveKey(passphrase, Buffer.from(salt, "base64")).toString("hex"));
    writeFileSync(masterKeyMetaPath(), JSON.stringify({ salt, check, createdAt: nowISO() }, null, 2), { mode: 0o600 });
    return v;
  }

  static exists(): boolean {
    return existsSync(vaultPath());
  }

  /** Open an existing vault; throws on wrong passphrase. */
  static open(passphrase: string): Vault {
    if (!existsSync(vaultPath())) throw new Error("vault not initialized — run `majordomo init`");
    // Verify passphrase against meta if present.
    if (existsSync(masterKeyMetaPath())) {
      const meta = JSON.parse(readFileSync(masterKeyMetaPath(), "utf8")) as { salt: string; check: string };
      const got = sha256(deriveKey(passphrase, Buffer.from(meta.salt, "base64")).toString("hex"));
      if (got !== meta.check) throw new Error("incorrect master key");
    }
    const blob = JSON.parse(readFileSync(vaultPath(), "utf8")) as EncBlob;
    const plain = decrypt(blob, passphrase);
    const data = JSON.parse(plain) as VaultData;
    return new Vault(data, passphrase);
  }

  private save(): void {
    const blob = encrypt(JSON.stringify(this.data), this.passphrase);
    writeFileSync(vaultPath(), JSON.stringify(blob, null, 2), { mode: 0o600 });
  }

  put(name: string, value: string, meta?: Record<string, unknown>): string {
    const ref = id("sec");
    this.data.secrets[ref] = { value, createdAt: nowISO(), meta: { name, ...meta } };
    this.save();
    return ref;
  }

  get(ref: string): string | undefined {
    return this.data.secrets[ref]?.value;
  }

  getMeta(ref: string): Record<string, unknown> | undefined {
    return this.data.secrets[ref]?.meta;
  }

  delete(ref: string): void {
    delete this.data.secrets[ref];
    this.save();
  }

  list(): { ref: string; name: string; createdAt: string }[] {
    return Object.entries(this.data.secrets).map(([ref, e]) => ({
      ref,
      name: String(e.meta?.name ?? "secret"),
      createdAt: e.createdAt,
    }));
  }
}
