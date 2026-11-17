import type {
  AgentSessionGrant,
  AgentSessionStore,
} from "../../src/identity/agent-session.js";

/**
 * In-memory AgentSessionStore for unit tests. Operations are atomic within a single
 * Node isolate only; not suitable for production or cross-request revocation guarantees.
 */
export function createMemoryAgentSessionStore(): AgentSessionStore {
  const grants = new Map<string, AgentSessionGrant>();
  return {
    async put(hash, grant) {
      if (grants.has(hash)) return false;
      grants.set(hash, { ...grant });
      return true;
    },
    async get(hash) {
      const grant = grants.get(hash);
      return grant ? { ...grant } : null;
    },
    async revoke(hash) {
      const grant = grants.get(hash);
      if (!grant || grant.revokedAtMs !== null) return false;
      grant.revokedAtMs = Date.now();
      return true;
    },
  };
}
