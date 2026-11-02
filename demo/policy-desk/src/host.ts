// Per-request host: Postgres connection and an in-process Task Authority
// service. The service handler is the REAL createHandler imported from
// auth0/service/src, configured with the REAL Auth0 issuer, JWKS and audience.
// Requests from this Worker to it never leave the isolate but travel the same
// Request/Response path as external clients.
import {
  DEMO_DEFAULTS,
  type ServiceConfig,
  type TenantConfig,
} from "../../../auth0/service/src/config.js";
import { createHandler } from "../../../auth0/service/src/http.js";
import { TaskAuthority, createTaskAuthority } from "@task-authority/sdk";
import {
  authorityAudience,
  clientToken,
  issuerOf,
  jwks,
  makeFga,
  peekSub,
  bearer,
  type Deps,
  type FgaAdmin,
  type Role,
} from "./auth0.js";
import { connect, type Conn } from "./db.js";
import { MAX_PENDING_APPROVALS, RESOURCE_SERVER, type Env } from "./env.js";
import type { PolicySettings } from "./policy.js";

export type Sandbox = {
  id: string;
  orgId: string;
  generation: number;
  createdAt: Date;
  expiresAt: Date;
  lastResetAt: Date;
  delegationId: string | null;
  delegationExpiresAt: Date | null;
  policyVersion: string | null;
  policySettings: PolicySettings | null;
};
export const tenantIdOf = (s: Pick<Sandbox, "id" | "generation">) =>
  `pd_${s.id.replace(/^sbx_/, "")}_g${s.generation}`;
export const SANDBOX_ID = /^sbx_[a-f0-9]{24}$/;

/** One sandbox per real Auth0 user: a stable id derived from the token subject. */
export async function sandboxIdFor(sub: string) {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`policy-desk|${sub}`),
  );
  return `sbx_${[...new Uint8Array(d)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

export type Host = {
  env: Env;
  deps: Deps;
  conn: Conn;
  origin: string;
  now: () => number;
  /** Set by a handler that streams its response: the connection closes when it settles. */
  streaming?: Promise<unknown>;
};

export async function openHost(
  env: Env,
  req: Request,
  deps: Deps = {},
): Promise<Host> {
  const conn = await connect(env);
  return {
    env,
    deps,
    conn,
    origin: (env.PUBLIC_URL ?? new URL(req.url).origin).replace(/\/$/, ""),
    now: Date.now,
  };
}

export async function loadSandbox(
  host: Host,
  id: string,
): Promise<Sandbox | null> {
  if (!SANDBOX_ID.test(id)) return null;
  const r = await host.conn.db.query(
    "select * from policy_desk.sandboxes where id=$1",
    [id],
  );
  const x = r.rows[0];
  if (!x) return null;
  return {
    id: x.id,
    orgId: x.org_id,
    generation: x.generation,
    createdAt: x.created_at,
    expiresAt: x.expires_at,
    lastResetAt: x.last_reset_at,
    delegationId: x.delegation_id,
    delegationExpiresAt: x.delegation_expires_at,
    policyVersion: x.policy_version,
    policySettings: x.policy_settings,
  };
}

export function fgaFor(host: Host, s: Sandbox): FgaAdmin {
  return makeFga(
    host.env,
    host.deps,
    host.conn.db,
    tenantIdOf(s),
    host.conn.timings,
  );
}

/** Sandbox-scoped tenant. Quotas make the real service enforce the abuse caps. */
export function tenantFor(host: Host, s: Sandbox): TenantConfig {
  const action = {
    requesterRelation: "refund_request",
    approverRelation: "refund_approve",
    policyVersion: "refunds",
    // Human-direct registration is only allowed against operator-named resource servers.
    resourceServers: [RESOURCE_SERVER],
  };
  return {
    tenantId: tenantIdOf(s),
    issuer: issuerOf(host.env),
    audience: authorityAudience(host.env),
    approvalClientId: host.env.APPROVAL_CLIENT_ID ?? host.env.AUTH0_CLIENT_ID,
    keys: jwks(host.env),
    fga: fgaFor(host, s),
    claimNamespace: host.env.AUTH0_CLAIM_NAMESPACE,
    actions: { "refund:create": action, "refund:void": action },
    defaults: { ...DEMO_DEFAULTS },
    quotas: {
      openDelegations: 3,
      openApprovals: MAX_PENDING_APPROVALS,
      claimsPerDay: 200,
      requestsPerMinute: 240,
    },
  };
}

export function serviceHandler(host: Host, s: Sandbox | null) {
  const config: ServiceConfig = {
    tenants: s ? [tenantFor(host, s)] : [],
    allowedOrigins: [],
    clockSkewSec: 30,
  };
  return createHandler({
    store: host.conn.store,
    config,
    now: host.now,
    log: (e) => {
      if (e.event === "request_failed") console.error(JSON.stringify(e));
    },
  });
}

/** Sandbox of a human `/v1` caller, chosen from the unverified subject; the service then verifies for real. */
export async function sandboxFromBearer(
  host: Host,
  req: Request,
): Promise<Sandbox | null> {
  const token = bearer(req);
  const p = token ? peekSub(token) : null;
  if (!p || p.isClient) return null;
  return loadSandbox(host, await sandboxIdFor(p.sub));
}

/** SDK client talking to the in-process real service as one backend role. */
export function sdk(
  host: Host,
  s: Sandbox,
  role: Role,
  handler = serviceHandler(host, s),
) {
  return new TaskAuthority({
    baseUrl: host.origin,
    getAccessToken: () => clientToken(host.env, host.deps, role),
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      handler(new Request(input, init))) as typeof fetch,
    retry: { retries: 1, baseDelayMs: 50, maxDelayMs: 200 },
  });
}

/**
 * The sandbox's customer app view of Task Authority: one configured client with
 * separate API and executor credentials. A real deployment reads the same
 * settings from TASK_AUTHORITY_* variables or task-authority.json instead.
 */
export function authorityApp(
  host: Host,
  s: Sandbox,
  handler = serviceHandler(host, s),
) {
  return createTaskAuthority({
    env: {},
    url: host.origin,
    resourceServer: RESOURCE_SERVER,
    organizationId: s.orgId,
    reviewUrl: `/review?approval={approvalId}&sandbox=${encodeURIComponent(s.id)}`,
    getAccessToken: () => clientToken(host.env, host.deps, "api"),
    getExecutorAccessToken: () => clientToken(host.env, host.deps, "executor"),
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      handler(new Request(input, init))) as typeof fetch,
    retry: { retries: 1, baseDelayMs: 50, maxDelayMs: 200 },
  });
}
