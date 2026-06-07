// Plaintext state store (everything except secret values, which live in the vault).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { storePath } from "./config.ts";
import { id, nowISO } from "./util/id.ts";
import type {
  StoreData, Org, ServiceInstance, RequestingAgent, Policy, Grant, RequestRecord, AuditEntry,
} from "./types.ts";

const EMPTY: StoreData = {
  version: 1,
  services: {},
  agents: {},
  policies: [],
  grants: {},
  requests: [],
  audit: [],
};

export class Store {
  data: StoreData;

  private constructor(data: StoreData) {
    this.data = data;
  }

  static exists(): boolean {
    return existsSync(storePath());
  }

  static load(): Store {
    if (!existsSync(storePath())) return new Store(structuredClone(EMPTY));
    const data = JSON.parse(readFileSync(storePath(), "utf8")) as StoreData;
    // Forward-compatible defaults.
    return new Store({ ...structuredClone(EMPTY), ...data });
  }

  save(): void {
    writeFileSync(storePath(), JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  // --- org ---
  setOrg(org: Org): void {
    this.data.org = org;
    this.save();
  }
  org(): Org | undefined {
    return this.data.org;
  }
  requireOrg(): Org {
    if (!this.data.org) throw new Error("not initialized — run `it init`");
    return this.data.org;
  }

  // --- services ---
  addService(s: ServiceInstance): void {
    this.data.services[s.id] = s;
    this.save();
  }
  service(idOrKey: string): ServiceInstance | undefined {
    return (
      this.data.services[idOrKey] ||
      Object.values(this.data.services).find((s) => s.catalogKey === idOrKey || s.displayName === idOrKey)
    );
  }
  services(): ServiceInstance[] {
    return Object.values(this.data.services);
  }

  // --- agents ---
  addAgent(a: RequestingAgent): void {
    this.data.agents[a.id] = a;
    this.save();
  }
  agent(idOrName: string): RequestingAgent | undefined {
    return this.data.agents[idOrName] || Object.values(this.data.agents).find((a) => a.name === idOrName);
  }
  agentByTokenHash(hash: string): RequestingAgent | undefined {
    return Object.values(this.data.agents).find((a) => a.tokenHash === hash && !a.disabled);
  }
  agents(): RequestingAgent[] {
    return Object.values(this.data.agents);
  }

  // --- policies ---
  addPolicy(p: Policy): void {
    this.data.policies.push(p);
    this.save();
  }
  policies(): Policy[] {
    return this.data.policies;
  }
  removePolicy(policyId: string): boolean {
    const before = this.data.policies.length;
    this.data.policies = this.data.policies.filter((p) => p.id !== policyId);
    this.save();
    return this.data.policies.length < before;
  }

  // --- grants ---
  addGrant(g: Grant): void {
    this.data.grants[g.id] = g;
    this.save();
  }
  grant(grantId: string): Grant | undefined {
    return this.data.grants[grantId];
  }
  grants(): Grant[] {
    return Object.values(this.data.grants);
  }
  grantsFor(agentId: string, serviceKey?: string): Grant[] {
    return this.grants().filter(
      (g) => g.agentId === agentId && g.status === "active" && (!serviceKey || g.serviceKey === serviceKey),
    );
  }

  // --- requests ---
  addRequest(r: RequestRecord): void {
    this.data.requests.unshift(r);
    this.data.requests = this.data.requests.slice(0, 500);
    this.save();
  }
  requests(): RequestRecord[] {
    return this.data.requests;
  }

  // --- audit ---
  audit(actor: string, event: string, detail: Record<string, unknown> = {}): void {
    const entry: AuditEntry = { id: id("aud"), at: nowISO(), actor, event, detail };
    this.data.audit.unshift(entry);
    this.data.audit = this.data.audit.slice(0, 2000);
    this.save();
  }
  auditLog(): AuditEntry[] {
    return this.data.audit;
  }
}
