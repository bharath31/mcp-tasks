import type { AgentActor, HumanActor, TrustedActor } from "../types.js";

/** Capabilities granted to bounded shopping agent sessions (no approval or execution). */
export const AGENT_SESSION_SCOPES = [
  "cart:write",
  "checkout:write",
  "addresses:read",
] as const;

export type AgentSessionGrant = {
  sessionId: string;
  agentId: string;
  pairwiseUserId: string;
  customerId: string;
  scopes: readonly string[];
  expiresAtMs: number;
  revokedAtMs: number | null;
};

/**
 * Durable storage for agent session grants, keyed by SHA-256 hash of the opaque bearer.
 *
 * **Atomicity expectations (callers must not assume more than the implementation provides):**
 * - `put` must reject duplicate hashes (collision) without overwriting an existing grant.
 * - `revoke` must be idempotent: revoking an unknown or already-revoked hash returns false.
 * - `get` after a successful `revoke` must return a grant with `revokedAtMs` set (or null if deleted).
 *
 * A Durable Object with a single-threaded isolate can satisfy these within one object.
 * Cross-request instant revocation is **not** guaranteed globally: the host must re-verify
 * the bearer on every merchant call; delayed revocation may still allow one in-flight request.
 */
export type AgentSessionStore = {
  put(hash: string, grant: AgentSessionGrant): Promise<boolean>;
  get(hash: string): Promise<AgentSessionGrant | null>;
  revoke(hash: string): Promise<boolean>;
};

export type AgentSessionService = {
  grantSession(
    customer: HumanActor,
  ): Promise<
    | { ok: true; bearer: string; expiresAt: string }
    | { ok: false; reason: "invalid_customer" | "storage_failed" }
  >;
  verifyBearer(bearer: string): Promise<TrustedActor | null>;
  revokeBearer(bearer: string): Promise<boolean>;
};

export type AgentSessionOptions = {
  store: AgentSessionStore;
  ttlMs?: number;
  now?: () => number;
  /** Server-accepted agent id for this merchant deployment. */
  merchantAgentId: string;
};

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const BEARER_PREFIX = "nsh_";

function assertHumanCustomer(customer: HumanActor): boolean {
  return (
    customer?.kind === "human" &&
    typeof customer.customerId === "string" &&
    customer.customerId.length > 0 &&
    Array.isArray(customer.scopes)
  );
}

async function hashBearer(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomOpaque(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${BEARER_PREFIX}${b64}`;
}

function grantToAgentActor(grant: AgentSessionGrant): AgentActor {
  return {
    kind: "agent",
    customerId: grant.customerId,
    agentId: grant.agentId,
    pairwiseUserId: grant.pairwiseUserId,
    sessionId: grant.sessionId,
    scopes: [...grant.scopes],
  };
}

export function createAgentSessionService(
  options: AgentSessionOptions,
): AgentSessionService {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const { store, merchantAgentId } = options;

  return {
    async grantSession(customer) {
      if (!assertHumanCustomer(customer)) {
        return { ok: false, reason: "invalid_customer" };
      }
      const bearer = randomOpaque();
      const hash = await hashBearer(bearer);
      const expiresAtMs = now() + ttlMs;
      const grant: AgentSessionGrant = {
        sessionId: crypto.randomUUID(),
        agentId: merchantAgentId,
        pairwiseUserId: crypto.randomUUID(),
        customerId: customer.customerId,
        scopes: [...AGENT_SESSION_SCOPES],
        expiresAtMs,
        revokedAtMs: null,
      };
      const inserted = await store.put(hash, grant);
      if (!inserted) return { ok: false, reason: "storage_failed" };
      return {
        ok: true,
        bearer,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },

    async verifyBearer(bearer) {
      if (!bearer?.startsWith(BEARER_PREFIX)) return null;
      const hash = await hashBearer(bearer);
      const grant = await store.get(hash);
      if (!grant) return null;
      if (grant.revokedAtMs !== null) return null;
      if (grant.expiresAtMs <= now()) return null;
      return grantToAgentActor(grant);
    },

    async revokeBearer(bearer) {
      if (!bearer?.startsWith(BEARER_PREFIX)) return false;
      const hash = await hashBearer(bearer);
      return store.revoke(hash);
    },
  };
}

/**
 * Reject caller-supplied agent JSON: only values produced by {@link verifyBearer}
 * may be forwarded to the merchant ledger as a {@link TrustedActor}.
 */
export function rejectUntrustedAgentActor(_actor: unknown): null {
  return null;
}
