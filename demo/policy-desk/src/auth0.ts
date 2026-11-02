// Real Auth0 integration points. Nothing here issues tokens: it verifies
// Auth0 access tokens against the tenant JWKS and obtains client-credentials /
// refresh-token tokens for the backend roles from the tenant's /oauth/token.
import {
  createRemoteJWKSet,
  decodeJwt,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from "jose";
import { OpenFgaHttp, type Fga } from "../../../auth0/service/src/fga.js";
import type { Db } from "../../../auth0/service/src/store.js";
import { ConfigError, need, type Env } from "./env.js";
import { PgFga } from "./fga.js";
import type { Timings } from "./db.js";

export type Deps = {
  fetch?: typeof fetch;
  /** Test seam: replaces the refresh-token exchange for the delegating user. */
  agentOwnerToken?: () => Promise<string>;
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export const issuerOf = (env: Env) => `https://${need(env, "AUTH0_DOMAIN")}/`;
export function jwks(env: Env) {
  const issuer = issuerOf(env);
  let s = jwksCache.get(issuer);
  if (!s) {
    s = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
    jwksCache.set(issuer, s);
  }
  return s;
}
export const authorityAudience = (env: Env) =>
  need(env, "TASK_AUTHORITY_AUDIENCE");
export const appAudience = (env: Env) =>
  env.APP_AUDIENCE || authorityAudience(env);
/** RFC 8707 resource for /mcp: MCP hosts that sign in on their own request a token for it. */
export const mcpResource = (env: Env, origin: string) =>
  env.MCP_RESOURCE || `${origin}/mcp`;

export type Verified = {
  sub: string;
  orgId: string | null;
  token: string;
  payload: JWTPayload;
  isClient: boolean;
};
/** Full signature/issuer/audience verification against the real tenant JWKS. */
export async function verifyToken(
  env: Env,
  token: string,
  audiences: string[],
): Promise<Verified | null> {
  try {
    const { payload } = await jwtVerify(token, jwks(env), {
      issuer: issuerOf(env),
      audience: audiences,
      algorithms: ["RS256", "ES256", "PS256"],
      requiredClaims: ["sub", "exp", "iat"],
    });
    return {
      sub: String(payload.sub),
      orgId: typeof payload.org_id === "string" ? payload.org_id : null,
      token,
      payload,
      isClient:
        payload.gty === "client-credentials" ||
        String(payload.sub).endsWith("@clients"),
    };
  } catch {
    return null;
  }
}
export const bearer = (req: Request) =>
  req.headers.get("authorization")?.match(/^(?:Bearer|DPoP) (\S+)$/)?.[1] ??
  null;
/** Unverified peek, used ONLY to choose which sandbox tenant to build; the service verifies for real. */
export function peekSub(
  token: string,
): { sub: string; isClient: boolean } | null {
  try {
    const p = decodeJwt(token);
    if (!p.sub) return null;
    return {
      sub: p.sub,
      isClient: p.gty === "client-credentials" || p.sub.endsWith("@clients"),
    };
  } catch {
    return null;
  }
}

const tokenCache = new Map<string, { token: string; exp: number }>();
async function tokenEndpoint(
  env: Env,
  deps: Deps,
  key: string,
  body: Record<string, string>,
) {
  key = `${issuerOf(env)}|${key}`;
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now() + 30_000) return hit.token;
  const res = await (deps.fetch ?? fetch)(`${issuerOf(env)}oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new ConfigError(`token_request_failed:${key}:${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(key, {
    token: j.access_token,
    exp: Date.now() + j.expires_in * 1000,
  });
  return j.access_token;
}
export type Role = "api" | "executor" | "auditor" | "admin" | "agent";
const ROLE_ENV: Record<Role, [keyof Env, keyof Env]> = {
  api: ["AUTHORITY_API_CLIENT_ID", "AUTHORITY_API_CLIENT_SECRET"],
  executor: [
    "AUTHORITY_EXECUTOR_CLIENT_ID",
    "AUTHORITY_EXECUTOR_CLIENT_SECRET",
  ],
  auditor: ["AUTHORITY_AUDITOR_CLIENT_ID", "AUTHORITY_AUDITOR_CLIENT_SECRET"],
  admin: ["AUTHORITY_ADMIN_CLIENT_ID", "AUTHORITY_ADMIN_CLIENT_SECRET"],
  agent: ["AGENT_CLIENT_ID", "AGENT_CLIENT_SECRET"],
};
export const clientIdOf = (env: Env, role: Role) =>
  need(env, ROLE_ENV[role][0]);
/** Auth0 client-credentials token for a backend role. */
export function clientToken(env: Env, deps: Deps, role: Role) {
  const [idKey, secretKey] = ROLE_ENV[role];
  const audience = role === "agent" ? appAudience(env) : authorityAudience(env);
  return tokenEndpoint(env, deps, `cc:${role}:${audience}`, {
    grant_type: "client_credentials",
    client_id: need(env, idKey),
    client_secret: need(env, secretKey),
    audience,
  });
}
/**
 * A fresh (never cached) client-credentials token for the external agent client. Auth0 signs
 * it; the Worker only binds it to one sandbox (agent-keys.ts) before handing it to the visitor.
 */
export async function mintExternalAgentToken(env: Env, deps: Deps) {
  const res = await (deps.fetch ?? fetch)(`${issuerOf(env)}oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: need(env, "EXTERNAL_AGENT_CLIENT_ID"),
      ...(await externalAgentAuth(env)),
      audience: appAudience(env),
    }),
  });
  if (!res.ok)
    throw new ConfigError(`token_request_failed:external_agent:${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  return { token: j.access_token, expiresInSec: j.expires_in };
}

/**
 * The external agent authenticates with private_key_jwt when EXTERNAL_AGENT_PRIVATE_KEY (PKCS#8
 * PEM, RS256) is set, otherwise with EXTERNAL_AGENT_CLIENT_SECRET.
 */
async function externalAgentAuth(env: Env): Promise<Record<string, string>> {
  const pem = env.EXTERNAL_AGENT_PRIVATE_KEY;
  if (!pem) return { client_secret: need(env, "EXTERNAL_AGENT_CLIENT_SECRET") };
  const id = need(env, "EXTERNAL_AGENT_CLIENT_ID");
  const key = await importPKCS8(pem.replace(/\\n/g, "\n"), "RS256");
  const assertion = await new SignJWT({})
    .setProtectedHeader({
      alg: "RS256",
      ...(env.EXTERNAL_AGENT_KEY_ID ? { kid: env.EXTERNAL_AGENT_KEY_ID } : {}),
    })
    .setIssuer(id)
    .setSubject(id)
    .setAudience(issuerOf(env))
    .setIssuedAt()
    .setExpirationTime("2m")
    .setJti(crypto.randomUUID())
    .sign(key);
  return {
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  };
}

/** The real Auth0 user who delegates to the agent (refresh-token grant, never stored by the Worker). */
export async function agentOwnerToken(env: Env, deps: Deps) {
  if (deps.agentOwnerToken) return deps.agentOwnerToken();
  return tokenEndpoint(env, deps, "owner", {
    grant_type: "refresh_token",
    client_id: need(env, "AGENT_OWNER_CLIENT_ID"),
    client_secret: need(env, "AGENT_OWNER_CLIENT_SECRET"),
    refresh_token: need(env, "AGENT_OWNER_REFRESH_TOKEN"),
    audience: authorityAudience(env),
  });
}

/** Writes need a separate credential; both can be Auth0 FGA client credentials. */
async function fgaToken(env: Env, deps: Deps, admin: boolean) {
  const st = admin ? env.FGA_ADMIN_TOKEN : env.FGA_API_TOKEN;
  if (st) return st;
  if (!env.FGA_CLIENT_ID || !env.FGA_CLIENT_SECRET) return undefined;
  return tokenEndpointFga(env, deps);
}
async function tokenEndpointFga(env: Env, deps: Deps) {
  const key = "fga";
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now() + 30_000) return hit.token;
  const res = await (deps.fetch ?? fetch)(
    env.FGA_TOKEN_URL ?? "https://auth.fga.dev/oauth/token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: env.FGA_CLIENT_ID,
        client_secret: env.FGA_CLIENT_SECRET,
        audience: env.FGA_TOKEN_AUDIENCE ?? "https://api.us1.fga.dev/",
      }),
    },
  );
  if (!res.ok) throw new ConfigError("fga_token_failed");
  const j = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(key, {
    token: j.access_token,
    exp: Date.now() + j.expires_in * 1000,
  });
  return j.access_token;
}

export type FgaAdmin = Fga & {
  /** Idempotent: tuples that already exist are skipped. */
  grant(
    tuples: Array<{ user: string; relation: string; object: string }>,
  ): Promise<void>;
};
/**
 * Deployed mode: the real OpenFgaHttp client against an Auth0 FGA store.
 * ALLOW_LOCAL_FGA=1 selects the Postgres tuple table, for local tests only.
 */
export function makeFga(
  env: Env,
  deps: Deps,
  db: Db,
  tenantId: string,
  timings?: Timings,
): FgaAdmin {
  if (!env.FGA_API_URL || !env.FGA_STORE_ID) {
    if (env.ALLOW_LOCAL_FGA !== "1")
      throw new ConfigError(
        "FGA_API_URL and FGA_STORE_ID are required (ALLOW_LOCAL_FGA=1 is for local tests only)",
      );
    const local = new PgFga(db, tenantId);
    return {
      check: (u, r, o) => local.check(u, r, o),
      grant: async (tuples) => {
        for (const t of tuples)
          await db.query(
            "insert into policy_desk.fga_tuples (tenant_id,subject,relation,object) values ($1,$2,$3,$4) on conflict do nothing",
            [tenantId, t.user, t.relation, t.object],
          );
      },
    };
  }
  const base = {
    apiUrl: env.FGA_API_URL,
    storeId: env.FGA_STORE_ID,
    modelId: env.FGA_MODEL_ID,
    fetch: deps.fetch,
  };
  const reader = new OpenFgaHttp({
    ...base,
    getToken: async () => (await fgaToken(env, deps, false)) ?? "",
  });
  const writer = new OpenFgaHttp({
    ...base,
    getToken: async () => (await fgaToken(env, deps, true)) ?? "",
  });
  const timed = async <T>(fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      if (timings) {
        timings.fgaCalls++;
        timings.fgaMs += Date.now() - t;
      }
    }
  };
  return {
    check: (u, r, o) => timed(() => reader.check(u, r, o)),
    // Each FGA call crosses to the FGA region, so check every tuple at once and write the
    // missing ones in a single request. A tuple that appeared meanwhile fails the batch;
    // then fall back to writing them one by one.
    grant: async (tuples) => {
      const have = await Promise.all(
        tuples.map((t) =>
          timed(() => writer.check(t.user, t.relation, t.object)),
        ),
      );
      const missing = tuples.filter((_, i) => !have[i]);
      if (!missing.length) return;
      try {
        await timed(() => writer.write(missing));
      } catch {
        for (const t of missing)
          if (!(await timed(() => writer.check(t.user, t.relation, t.object))))
            await timed(() => writer.write([t]));
      }
    },
  };
}
