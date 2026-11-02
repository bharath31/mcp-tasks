import { decodeJwt } from "jose";
import { verifiedAgent, verifiedSubject } from "@task-authority/sdk";
import {
  agentOwnerToken,
  clientToken,
  peekSub,
  type Verified,
} from "./auth0.js";
import {
  DEFAULT_AGENT_ID,
  RESOURCE_SERVER,
  SANDBOX_TTL_MINUTES,
} from "./env.js";
import {
  fgaFor,
  loadSandbox,
  sandboxIdFor,
  sdk,
  serviceHandler,
  tenantIdOf,
  type Host,
  type Sandbox,
} from "./host.js";
import { seedOrders, type Order } from "./orders.js";
import { Guardrail } from "./problem.js";
import {
  DEFAULT_SETTINGS,
  MAX_POLICY_PUBLISHES_PER_HOUR,
  sandboxPolicy,
  type PolicySettings,
} from "./policy.js";

export const DELEGATED_ACTIONS = ["refund:create", "refund:void"];
export const agentIdOf = (host: Host) => host.env.AGENT_ID || DEFAULT_AGENT_ID;
export const DEFAULT_POLICY_VERSION = "refunds.v1";

/** Creates (or returns) the visitor's own sandbox row. One real user, one sandbox. */
export async function ensureSandbox(
  host: Host,
  who: Pick<Verified, "sub" | "orgId">,
  ipHash: string,
): Promise<Sandbox> {
  const id = await sandboxIdFor(who.sub);
  const existing = await loadSandbox(host, id);
  if (existing) {
    if (existing.orgId !== who.orgId)
      throw new Guardrail(
        409,
        "sandbox_org_changed",
        "This sandbox was created in a different organization.",
        {
          hint: "Sign in with the original organization.",
          nextAction: "sign_in",
        },
      );
    return existing;
  }
  const now = host.now();
  await host.conn.db.query(
    "insert into policy_desk.sandboxes (id,org_id,generation,created_at,expires_at,last_reset_at,ip_hash) values ($1,$2,0,$3,$4,$3,$5) on conflict do nothing",
    [
      id,
      who.orgId,
      new Date(now).toISOString(),
      new Date(now + SANDBOX_TTL_MINUTES * 60_000).toISOString(),
      ipHash,
    ],
  );
  return (await loadSandbox(host, id))!;
}

/** Policy versions this sandbox generation published in the last hour (the cap counts these). */
export async function publishesLastHour(host: Host, s: Sandbox) {
  const n = await host.conn.db.query(
    "select count(*)::int n from authority.policy_versions where tenant_id=$1 and created_at > now() - interval '1 hour'",
    [tenantIdOf(s)],
  );
  return Number(n.rows[0].n);
}

/** Publishes and activates a policy version through the REAL /v1/policies API. */
export async function publishPolicy(
  host: Host,
  s: Sandbox,
  settings: PolicySettings,
  version: string,
  opts: { enforceCap: boolean },
) {
  if (opts.enforceCap) {
    if ((await publishesLastHour(host, s)) >= MAX_POLICY_PUBLISHES_PER_HOUR)
      throw new Guardrail(
        429,
        "policy_publish_limit",
        `A sandbox may publish at most ${MAX_POLICY_PUBLISHES_PER_HOUR} policy versions per hour.`,
        {
          hint: "Wait, or use Reset to start over.",
          nextAction: "retry_later",
          retryAfterSec: 600,
        },
      );
  }
  const handler = serviceHandler(host, s);
  const admin = await clientToken(host.env, host.deps, "admin");
  const res = await handler(
    new Request(
      `${host.origin}/v1/policies/${encodeURIComponent(RESOURCE_SERVER)}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${admin}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          document: sandboxPolicy(settings, version, host.env),
          activate: true,
        }),
      },
    ),
  );
  if (res.status !== 201)
    throw new Guardrail(
      502,
      "policy_publish_failed",
      "The Task Authority service refused the policy.",
      {
        hint: `status ${res.status}`,
        nextAction: "retry_later",
      },
    );
  await host.conn.db.query(
    "update policy_desk.sandboxes set policy_version=$2, policy_settings=$3 where id=$1",
    [s.id, version, JSON.stringify(settings)],
  );
}

/** Starts a new data generation (new tenant id) and seeds it through the real service and real FGA. */
export async function seedGeneration(
  host: Host,
  current: Sandbox,
  visitor: Verified,
  opts: { allowAuthenticatorApp?: boolean } = {},
): Promise<{ sandbox: Sandbox; orders: Order[] }> {
  const { db } = host.conn;
  const gen: Sandbox = {
    ...current,
    generation: current.generation + 1,
    delegationId: null,
    delegationExpiresAt: null,
  };
  const tenantId = tenantIdOf(gen);
  const object = `organization:${gen.orgId}`;
  const agent = agentIdOf(host);
  const ownerToken = await agentOwnerToken(host.env, host.deps);
  const owner = peekSub(ownerToken);
  if (!owner) throw new Error("agent_owner_token_invalid");
  if (decodeJwt(ownerToken).org_id !== visitor.orgId)
    throw new Guardrail(
      403,
      "wrong_organization",
      "Your account belongs to a different organization than the sandbox agent's owner.",
      {
        hint: "Sign in through the demo organization.",
        nextAction: "sign_in",
      },
    );
  const fga = fgaFor(host, gen);
  await fga.grant([
    ...["member", "refund_request", "refund_approve"].map((relation) => ({
      user: `user:${visitor.sub}`,
      relation,
      object,
    })),
    ...["member", "refund_request"].map((relation) => ({
      user: `user:${owner.sub}`,
      relation,
      object,
    })),
    { user: `agent:${agent}`, relation: "registered_agent", object },
    {
      user: `client:${host.env.AUTHORITY_API_CLIENT_ID}`,
      relation: "trusted_backend",
      object,
    },
    {
      user: `client:${host.env.AUTHORITY_EXECUTOR_CLIENT_ID}`,
      relation: "trusted_backend",
      object,
    },
  ]);

  // Bump the generation first so the tenant row exists for the service path. A reset is a
  // fresh start, so it restarts the lifetime too: otherwise resetting an expired sandbox
  // reports success and every later request is still 410 sandbox_expired.
  await db.query(
    "update policy_desk.sandboxes set generation=$2, last_reset_at=$3, expires_at=$4, delegation_id=null, delegation_expires_at=null where id=$1",
    [
      gen.id,
      gen.generation,
      new Date(host.now()).toISOString(),
      new Date(host.now() + SANDBOX_TTL_MINUTES * 60_000).toISOString(),
    ],
  );
  await publishPolicy(
    host,
    gen,
    {
      ...DEFAULT_SETTINGS,
      allowAuthenticatorApp: !!opts.allowAuthenticatorApp,
    },
    DEFAULT_POLICY_VERSION,
    { enforceCap: false },
  );
  const delegation = await createDelegation(host, gen, ownerToken);
  const orders = await seedOrders(db, tenantId, gen.id);
  await db.query(
    "update policy_desk.sandboxes set delegation_id=$2, delegation_expires_at=$3 where id=$1",
    [gen.id, delegation.id, delegation.expiresAt],
  );
  return { sandbox: (await loadSandbox(host, gen.id))!, orders };
}

/**
 * The real Auth0 user "Alex" (never the reviewer) delegates refunds to the agent with a
 * user-owned delegation, so the visitor is free to approve what the agent requests.
 */
export async function createDelegation(
  host: Host,
  s: Sandbox,
  ownerToken?: string,
) {
  const token = ownerToken ?? (await agentOwnerToken(host.env, host.deps));
  return sdk(host, s, "api").delegations.create({
    owner: verifiedSubject({ accessToken: token, organizationId: s.orgId }),
    agent: verifiedAgent(agentIdOf(host)),
    ownerType: "user",
    resource: `merchant:${s.orgId}/refunds`,
    actions: DELEGATED_ACTIONS,
    // Outlives the sandbox by more than delegationFresh's 5-minute margin.
    expiresAt: new Date(
      host.now() + (SANDBOX_TTL_MINUTES + 10) * 60_000,
    ).toISOString(),
    reason: "Sandbox agent delegation",
  });
}

export const delegationFresh = (host: Host, s: Sandbox) =>
  !!s.delegationId &&
  !!s.delegationExpiresAt &&
  s.delegationExpiresAt.getTime() - 5 * 60_000 > host.now();

/** Re-creates a missing or nearly expired delegation with Alex's token (refreshed from his refresh token). */
export async function refreshDelegation(host: Host, s: Sandbox) {
  if (delegationFresh(host, s)) return s;
  const d = await createDelegation(host, s);
  await host.conn.db.query(
    "update policy_desk.sandboxes set delegation_id=$2, delegation_expires_at=$3 where id=$1",
    [s.id, d.id, d.expiresAt],
  );
  return {
    ...s,
    delegationId: d.id,
    delegationExpiresAt: new Date(d.expiresAt),
  };
}
