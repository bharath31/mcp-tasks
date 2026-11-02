// Sandbox agent keys: how a visitor's OWN agent (Claude Code, or any MCP or REST client)
// joins their sandbox. The key is a real Auth0 access token for the external agent M2M
// client, minted on the visitor's request and bound here to exactly one sandbox. The
// Worker never signs anything: it stores only a SHA-256 of the token, and accepts the
// external client's tokens solely through this binding, so a key can neither choose
// another sandbox nor outlive its revocation. The agent then acts exactly like the
// built-in agent: under Alex's delegation, with every refund decided by Task Authority
// and every approval made by the visitor on the hosted page with a fresh passkey.
import { mintExternalAgentToken } from "./auth0.js";
import type { Host, Sandbox } from "./host.js";
import { Guardrail } from "./problem.js";

/** The token's own lifetime still applies; this caps a key Auth0 would let live longer. */
export const AGENT_KEY_MAX_TTL_SEC = 24 * 3600;

export const externalAgentsEnabled = (host: Host) =>
  !!host.env.EXTERNAL_AGENT_CLIENT_ID &&
  !!(
    host.env.EXTERNAL_AGENT_CLIENT_SECRET || host.env.EXTERNAL_AGENT_PRIVATE_KEY
  );

async function sha256(token: string) {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type AgentKeyStatus = {
  connected: boolean;
  createdAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
};

export async function agentKeyStatus(
  host: Host,
  s: Sandbox,
): Promise<AgentKeyStatus> {
  const r = await host.conn.db.query(
    `select created_at, expires_at, last_used_at from policy_desk.agent_keys
     where sandbox_id=$1 and expires_at > $2 order by created_at desc limit 1`,
    [s.id, new Date(host.now()).toISOString()],
  );
  const row = r.rows[0];
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    connected: !!row,
    createdAt: iso(row?.created_at),
    expiresAt: iso(row?.expires_at),
    lastUsedAt: iso(row?.last_used_at),
  };
}

/** Mints a key for this sandbox and revokes any earlier one: one connected agent per sandbox. */
export async function issueAgentKey(host: Host, s: Sandbox) {
  if (!externalAgentsEnabled(host))
    throw new Guardrail(
      503,
      "not_configured",
      "Connecting your own agent is not set up on this deployment.",
      {
        hint: "The operator must create the external agent client (EXTERNAL_AGENT_CLIENT_ID).",
        nextAction: "contact_operator",
      },
    );
  const { token, expiresInSec } = await mintExternalAgentToken(
    host.env,
    host.deps,
  );
  const now = host.now();
  const ttl = Math.min(
    Math.max(1, Number(expiresInSec) || 0),
    AGENT_KEY_MAX_TTL_SEC,
  );
  const expiresAt = new Date(now + ttl * 1000);
  const hash = await sha256(token);
  const inserted = await host.conn.store.tx(async (db) => {
    await db.query("delete from policy_desk.agent_keys where sandbox_id=$1", [
      s.id,
    ]);
    // Two identical tokens would mean two sandboxes share one key; refuse rather than rebind.
    return db.query(
      `insert into policy_desk.agent_keys (token_hash, sandbox_id, created_at, expires_at)
       values ($1,$2,$3,$4) on conflict (token_hash) do nothing returning token_hash`,
      [hash, s.id, new Date(now).toISOString(), expiresAt.toISOString()],
    );
  });
  if (!inserted.rows.length)
    throw new Guardrail(
      503,
      "dependency_unavailable",
      "Could not issue a unique agent key.",
      { nextAction: "retry_later", retryAfterSec: 2 },
    );
  return { token, expiresAt: expiresAt.toISOString() };
}

export async function revokeAgentKeys(host: Host, s: Sandbox) {
  const r = await host.conn.db.query(
    "delete from policy_desk.agent_keys where sandbox_id=$1",
    [s.id],
  );
  return r.rowCount ?? 0;
}

/** The sandbox a live key is bound to, or null when it was revoked, replaced or has expired. */
export async function boundSandboxId(
  host: Host,
  token: string,
): Promise<string | null> {
  const now = new Date(host.now()).toISOString();
  // One round trip: find the binding and record that the agent is using it.
  const r = await host.conn.db.query(
    `update policy_desk.agent_keys set last_used_at=$2
     where token_hash=$1 and expires_at > $2
     returning sandbox_id`,
    [await sha256(token), now],
  );
  return (r.rows[0]?.sandbox_id as string | undefined) ?? null;
}
