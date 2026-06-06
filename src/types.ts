// Shared types for majordomo. Erasable-only (types + a couple of const unions).

export type ConnectorMode = "api" | "browser";
export type ServiceStatus = "needs-signup" | "configured" | "active" | "error";

/** A capability a connector exposes, e.g. supabase:create_project. */
export type Capability = {
  action: string; // e.g. "create_project", "buy_number"
  title: string;
  description: string;
  /** JSON-schema-ish parameter hints the brain can fill. */
  params?: Record<string, { type: string; description: string; required?: boolean; default?: unknown }>;
};

/** A service definition from the catalog (a template, not an instance). */
export type CatalogEntry = {
  key: string; // "supabase"
  displayName: string;
  homepage: string;
  signupUrl: string;
  docsUrl?: string;
  mode: ConnectorMode; // preferred fulfilment mode
  /** Names of the root/admin secrets this service needs to operate (vault refs). */
  rootSecrets: { name: string; label: string; help: string }[];
  capabilities: Capability[];
  tags: string[];
};

/** A configured instance of a service for this org. */
export type ServiceInstance = {
  id: string;
  catalogKey: string; // catalog preset key, or the free-form slug for ad-hoc services
  displayName: string;
  status: ServiceStatus;
  mode: ConnectorMode;
  account?: { email?: string; orgId?: string; dashboardUrl?: string; [k: string]: unknown };
  /** vault refs for the root/admin secrets. name -> secretRef */
  rootSecretRefs: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  /** True when this service was added free-form (not from the catalog). */
  adhoc?: boolean;
  /** URLs the agentic connector uses to sign up / call / read docs for ANY service. */
  signupUrl?: string;
  apiBase?: string;
  docsUrl?: string;
  homepage?: string;
  /** Capabilities (from a catalog preset, or a generic default for ad-hoc services). */
  capabilities?: Capability[];
  /** Names of root secrets this service expects (for ad-hoc services). */
  rootSecretNames?: string[];
};

/** A requesting agent — a client that asks majordomo for access. */
export type RequestingAgent = {
  id: string;
  name: string;
  description?: string;
  tokenHash: string; // sha256 of the bearer token
  tokenPrefix: string; // first chars, for display
  disabled: boolean;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type PolicyAction = "read" | "provision" | "signup" | "*";

/** An access policy: which agent may do which actions on which services. */
export type Policy = {
  id: string;
  agentId: string | "*";
  serviceKey: string | "*"; // catalog key or "*"
  actions: PolicyAction[];
  /** Max number of live grants this policy may produce (0 = unlimited). */
  maxGrants: number;
  /** If true, the request is queued for human approval instead of auto-fulfilled. */
  requiresApproval: boolean;
  createdAt: string;
};

/** A grant: scoped credentials handed to a requesting agent. */
export type Grant = {
  id: string;
  agentId: string;
  serviceId: string;
  serviceKey: string;
  action: string;
  /** Human description of what was provisioned. */
  resource: Record<string, unknown>;
  /** Secret values returned to the agent, by name. Stored as vault refs. */
  secretRefs: Record<string, string>;
  scopes: string[];
  status: "active" | "revoked" | "pending-approval";
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
};

export type RequestRecord = {
  id: string;
  agentId: string;
  prompt: string;
  decision?: {
    serviceKey?: string;
    action?: string;
    params?: Record<string, unknown>;
    reasoning?: string;
  };
  outcome: "fulfilled" | "denied" | "pending-approval" | "error" | "needs-signup";
  grantId?: string;
  message: string;
  createdAt: string;
};

export type AuditEntry = {
  id: string;
  at: string;
  actor: string; // "human", agent id, or "system"
  event: string;
  detail: Record<string, unknown>;
};

export type Org = {
  name: string;
  slug: string;
  contactEmail: string;
  createdAt: string;
};

export type StoreData = {
  version: number;
  org?: Org;
  services: Record<string, ServiceInstance>;
  agents: Record<string, RequestingAgent>;
  policies: Policy[];
  grants: Record<string, Grant>;
  requests: RequestRecord[];
  audit: AuditEntry[];
};

/** Context passed to a connector for a fulfilment operation. */
export type ConnectorContext = {
  org: Org;
  service: ServiceInstance;
  /** Resolve a vaulted secret value by ref. */
  getSecret: (ref: string) => string | undefined;
  /** Store a secret, returns its ref. */
  putSecret: (name: string, value: string) => string;
  simulate: boolean;
  log: (msg: string) => void;
};

export type ProvisionResult = {
  ok: boolean;
  /** Description of the resource created. */
  resource: Record<string, unknown>;
  /** Secrets to return to the agent: name -> value. */
  secrets: Record<string, string>;
  scopes?: string[];
  message: string;
};

export type SignupResult = {
  ok: boolean;
  account: { email?: string; orgId?: string; dashboardUrl?: string; [k: string]: unknown };
  /** Root/admin secrets captured during signup: name -> value. */
  rootSecrets: Record<string, string>;
  message: string;
};

export type Connector = {
  key: string;
  mode: ConnectorMode;
  capabilities: Capability[];
  /** Create an org account on the service (API or browser). */
  signup?: (ctx: ConnectorContext) => Promise<SignupResult>;
  /** Provision a resource and return scoped credentials. */
  provision: (ctx: ConnectorContext, action: string, params: Record<string, unknown>) => Promise<ProvisionResult>;
};
