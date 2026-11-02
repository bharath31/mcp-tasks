// TEST-ONLY harness. The identity provider is auth0/tests/helpers/oidc-server.ts, a local
// standards-shaped stand-in for Auth0 (NOT Auth0). Everything else is the real code:
// the Worker app, the real Task Authority service handler, Postgres.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // this (test) process only
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from "jose";
import pg from "pg";
import { createApp } from "../../src/app.js";
import type { Env } from "../../src/env.js";
import { createTestDb } from "../../../../auth0/tests/helpers/pg.js";
import {
  MFA_CODE,
  startOidcServer,
  type OidcServer,
} from "../../../../auth0/tests/helpers/oidc-server.js";

const require = createRequire(import.meta.url);
const agentApprovalAction = require("../../../../auth0/actions/agent-approval.cjs");

export const ORIGIN = "https://policy-desk.test";
export const AUD = "https://policy-desk.test/task-authority";
export const SPA = "spa_client";
const MIG = new URL("../../../../auth0/service/migrations/", import.meta.url);
export const migrations = () => [
  ...readdirSync(MIG)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(new URL(name, MIG), "utf8") })),
  ...[
    "0001_policy_desk.sql",
    "0002_dpop_replay.sql",
    "0003_runtime_role.sql",
    "0004_usage.sql",
    "0005_agent_conversations.sql",
    "0006_approval_ledger.sql",
    "0007_agent_keys.sql",
  ].map((f) => ({
    name: `policy-desk/${f}`,
    sql: readFileSync(
      new URL(`../../src/migrations/${f}`, import.meta.url),
      "utf8",
    ),
  })),
];

const PERMS = {
  api: [
    "delegations:create",
    "delegations:read",
    "operations:register",
    "operations:read",
    "operations:cancel",
    "approvals:request",
    "approvals:read",
  ],
  executor: ["operations:read", "claims:create", "outcomes:report"],
  auditor: [
    "usage:read",
    "audit:read",
    "operations:read",
    "delegations:read",
    "approvals:read",
  ],
  admin: ["policies:write", "policies:read"],
};
export const ORG = "org_policy_desk";

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

export async function startWorld() {
  const users = [
    {
      key: "alice",
      sub: "auth0|alice",
      name: "Alice",
      org: ORG,
      email: "alice@example.test",
    },
    { key: "bob", sub: "auth0|bob", name: "Bob", org: ORG, roles: ["finance"] },
    { key: "owner", sub: "auth0|alex", name: "Alex (agent owner)", org: ORG },
    {
      key: "carol",
      sub: "auth0|carol",
      name: "Carol",
      org: ORG,
      email: "carol@example.test",
    },
    {
      key: "outsider",
      sub: "auth0|outsider",
      name: "Outsider",
      org: "org_other",
    },
  ];
  const oidc: OidcServer = await startOidcServer({
    users,
    clients: [
      { id: "api", secret: "api-s", permissions: PERMS.api },
      { id: "executor", secret: "exe-s", permissions: PERMS.executor },
      { id: "auditor", secret: "aud-s", permissions: PERMS.auditor },
      { id: "admin", secret: "adm-s", permissions: PERMS.admin },
      { id: "agent", secret: "agt-s", permissions: [] },
      { id: "external-agent", secret: "ext-s", permissions: [] },
      { id: SPA, redirectUris: ["http://127.0.0.1:1/cb"] },
      {
        id: "approvals",
        secret: "approval-secret",
        redirectUris: [`${ORIGIN}/approve/callback`],
      },
    ],
    resourceAudiences: [AUD],
    postLoginActions: [agentApprovalAction],
  });
  const db = await createTestDb("pd");
  const env: Env = {
    DATABASE_URL: db.url,
    AUTH0_DOMAIN: oidc.domain,
    TASK_AUTHORITY_AUDIENCE: AUD,
    AUTHORITY_API_CLIENT_ID: "api",
    AUTHORITY_API_CLIENT_SECRET: "api-s",
    AUTHORITY_EXECUTOR_CLIENT_ID: "executor",
    AUTHORITY_EXECUTOR_CLIENT_SECRET: "exe-s",
    AUTHORITY_AUDITOR_CLIENT_ID: "auditor",
    AUTHORITY_AUDITOR_CLIENT_SECRET: "aud-s",
    AUTHORITY_ADMIN_CLIENT_ID: "admin",
    AUTHORITY_ADMIN_CLIENT_SECRET: "adm-s",
    AGENT_CLIENT_ID: "agent",
    AGENT_CLIENT_SECRET: "agt-s",
    AGENT_ID: "agent_returns",
    EXTERNAL_AGENT_CLIENT_ID: "external-agent",
    EXTERNAL_AGENT_CLIENT_SECRET: "ext-s",
    ALLOW_LOCAL_FGA: "1", // local test fallback; deployed mode uses the real FGA store
    IP_HASH_SALT: "test",
    SPA_CLIENT_ID: SPA,
  };
  /** ID token issued alongside each access token from login(), for X-Id-Token. */
  const idTokens = new Map<string, string>();

  async function login(
    userKey: string,
    o: {
      details?: unknown[];
      stepUp?: boolean;
      dpop?: { key: CryptoKey; jwk: Record<string, unknown> };
      /** The second factor the fake Universal Login completes (default otp). */
      factor?: "otp" | "webauthn-platform" | "webauthn-roaming";
      /** A Task Authority approval challenge carried into the token. */
      challenge?: string;
    } = {},
  ) {
    const verifier = randomUUID() + randomUUID();
    const q = new URLSearchParams({
      client_id: SPA,
      redirect_uri: "http://127.0.0.1:1/cb",
      response_type: "code",
      state: "s",
      nonce: "n",
      audience: AUD,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      _user: userKey,
    });
    if (o.details) q.set("authorization_details", JSON.stringify(o.details));
    if (o.stepUp) q.set("acr_values", "mfa");
    if (o.details || o.stepUp) q.set("_mfa", MFA_CODE);
    if (o.factor) q.set("_factor", o.factor);
    // Like the SPA: no max_age, so the email sign-in stands and only the factor is fresh.
    if (o.challenge) q.set("task_authority_challenge", o.challenge);
    const authz = await fetch(`${oidc.issuer}authorize`, {
      method: "POST",
      redirect: "manual",
      body: q,
    });
    if (authz.status !== 302)
      throw new Error(`authorize refused: ${authz.status}`);
    const code = new URL(authz.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const headers: Record<string, string> = {};
    if (o.dpop)
      headers.dpop = await new SignJWT({
        htm: "POST",
        htu: `${oidc.issuer}oauth/token`,
      })
        .setProtectedHeader({
          typ: "dpop+jwt",
          alg: "ES256",
          jwk: o.dpop.jwk as never,
        })
        .setIssuedAt()
        .setJti(randomUUID())
        .sign(o.dpop.key);
    const tok = (await (
      await fetch(`${oidc.issuer}oauth/token`, {
        method: "POST",
        headers,
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: SPA,
          code,
          redirect_uri: "http://127.0.0.1:1/cb",
          code_verifier: verifier,
        }),
      })
    ).json()) as { access_token: string; id_token?: string };
    if (tok.id_token) idTokens.set(tok.access_token, tok.id_token);
    return tok.access_token;
  }

  const app = createApp({
    migrations: migrations(),
    deps: { agentOwnerToken: () => login("owner") },
  });
  const raw = (
    path: string,
    init: RequestInit & {
      token?: string;
      dpop?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.token)
      headers.authorization = `${init.dpop ? "DPoP" : "Bearer"} ${init.token}`;
    if (init.dpop) headers.dpop = init.dpop;
    if (init.body && !headers["content-type"])
      headers["content-type"] = "application/json";
    headers["cf-connecting-ip"] ??= "203.0.113.7";
    return app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body,
      }),
      env,
    );
  };
  const call = async (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const r = await raw(path, {
      method,
      token,
      headers: extra,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return {
      status: r.status,
      json: text ? (JSON.parse(text) as any) : null,
      headers: r.headers,
    };
  };

  async function dpopKey() {
    const { publicKey, privateKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    return {
      key: privateKey,
      jwk: (await exportJWK(publicKey)) as Record<string, unknown>,
    };
  }
  /** A DPoP-bound, MFA-stepped-up reviewer session and a function that proves each request. */
  async function reviewer(
    userKey: string,
    details?: unknown[],
    o: Parameters<typeof login>[1] = {},
  ) {
    const k = o.dpop ?? (await dpopKey());
    const token = await login(userKey, {
      stepUp: true,
      ...o,
      dpop: k,
      details,
    });
    const prove = (method: string, path: string) =>
      new SignJWT({
        htm: method,
        htu: `${ORIGIN}${path}`,
        ath: b64url(createHash("sha256").update(token).digest()),
      })
        .setProtectedHeader({
          typ: "dpop+jwt",
          alg: "ES256",
          jwk: k.jwk as never,
        })
        .setIssuedAt()
        .setJti(randomUUID())
        .sign(k.key);
    return {
      token,
      prove,
      async post(path: string, body: unknown) {
        const proof = await new SignJWT({
          htm: "POST",
          htu: `${ORIGIN}${path}`,
          ath: b64url(createHash("sha256").update(token).digest()),
        })
          .setProtectedHeader({
            typ: "dpop+jwt",
            alg: "ES256",
            jwk: k.jwk as never,
          })
          .setIssuedAt()
          .setJti(randomUUID())
          .sign(k.key);
        const r = await raw(path, {
          method: "POST",
          token,
          dpop: proof,
          body: JSON.stringify(body),
        });
        return { status: r.status, json: (await r.json()) as any };
      },
    };
  }
  void calculateJwkThumbprint;

  /**
   * What the reviewer page does for a per-operation tier: a plain DPoP-bound
   * sign-in asks the service for a challenge bound to this approval, then a fresh
   * sign-in with the given factor carries it into a single-use decision token.
   */
  async function decideWithStepUp(
    userKey: string,
    approvalId: string,
    operationDigest: string,
    o: {
      decision?: "approve" | "reject";
      factor?: "otp" | "webauthn-platform" | "webauthn-roaming";
    } = {},
  ) {
    const k = await dpopKey();
    const session = await reviewer(userKey, undefined, {
      dpop: k,
      stepUp: false,
    });
    const c = await session.post(
      `/v1/approval-requests/${approvalId}/challenge`,
      {},
    );
    if (c.status !== 200) return c;
    const fresh = await reviewer(userKey, undefined, {
      dpop: k,
      factor: o.factor ?? "webauthn-platform",
      challenge: c.json.challenge,
    });
    return fresh.post(`/v1/approval-requests/${approvalId}/decisions`, {
      decision: o.decision ?? "approve",
      operationDigest,
    });
  }

  const pool = () => new pg.Pool({ connectionString: db.url, max: 2 });
  return {
    oidc,
    env,
    db,
    app,
    raw,
    call,
    login,
    idTokenFor: (accessToken: string) => idTokens.get(accessToken),
    reviewer,
    decideWithStepUp,
    dpopKey,
    pool,
    async close() {
      await oidc.close();
      await db.drop();
    },
  };
}
export type World = Awaited<ReturnType<typeof startWorld>>;
