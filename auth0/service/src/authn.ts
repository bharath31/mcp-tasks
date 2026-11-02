import {
  decodeJwt,
  jwtVerify,
  decodeProtectedHeader,
  importJWK,
  calculateJwkThumbprint,
  type JWTPayload,
} from "jose";
import { createHash } from "node:crypto";
import type { Db } from "./store.js";
import { ServiceError } from "./errors.js";
import type { ServiceConfig, TenantConfig } from "./config.js";

export const SUBJECT_HEADER = "x-task-authority-subject";
export const NS = "https://task-authority.example/";

/** A verified human principal. Built only from a signature-checked token. */
export type Subject = {
  sub: string;
  orgId: string | null;
  amr: string[];
  acr?: string | null;
  authTime: number | null;
  /** Access-token `scope` and RBAC `permissions`: explicit grants carried by a signed human token. */
  grants: string[];
  iat: number;
  jti: string | null;
  authorizationDetails: Array<Record<string, unknown>>;
  actorType?: "human" | "agent" | "service";
  act?: Record<string, unknown> | null;
  dpopJkt?: string | null;
  approvalChallenge?: string | null;
};

export type Caller =
  | {
      kind: "service";
      tenant: TenantConfig;
      clientId: string;
      permissions: Set<string>;
      actorType?: "human" | "agent" | "service";
      act?: Record<string, unknown> | null;
      /** Optional verified end-user forwarded by the trusted backend. */
      subject: Subject | null;
    }
  | { kind: "user"; tenant: TenantConfig; subject: Subject };

function tenantFor(config: ServiceConfig, token: string): TenantConfig {
  let issuer: unknown;
  try {
    issuer = decodeJwt(token).iss;
  } catch {
    throw new ServiceError("invalid_identity", "Malformed bearer token.");
  }
  const tenant = config.tenants.find((t) => t.issuer === issuer);
  if (!tenant)
    throw new ServiceError("invalid_identity", "Unrecognised token issuer.");
  return tenant;
}

async function verify(
  config: ServiceConfig,
  token: string,
  now: number,
  expectTenant?: TenantConfig,
): Promise<{ tenant: TenantConfig; payload: JWTPayload }> {
  const tenant = tenantFor(config, token);
  if (expectTenant && expectTenant.tenantId !== tenant.tenantId)
    throw new ServiceError(
      "invalid_tenant",
      "Subject belongs to another tenant.",
    );
  try {
    const { payload } = await jwtVerify(token, tenant.keys, {
      issuer: tenant.issuer,
      audience: tenant.audience,
      algorithms: ["RS256", "ES256", "PS256"],
      clockTolerance: config.clockSkewSec,
      currentDate: new Date(now),
      requiredClaims: ["sub", "exp", "iat"],
    });
    return { tenant, payload };
  } catch {
    // No detail: the reason (signature, audience, expiry) is not an oracle.
    throw new ServiceError("invalid_identity", "Bearer token rejected.");
  }
}

const isClient = (p: JWTPayload) =>
  p.gty === "client-credentials" || String(p.sub).endsWith("@clients");

function subjectFrom(p: JWTPayload, ns = NS): Subject {
  // Auth0's Action carries the completed MFA factor alongside standard primary
  // authentication claims. Both arrays are covered by the issuer signature.
  const amr = [
    ...new Set(
      [
        ...(Array.isArray(p.amr) ? p.amr : []),
        ...(Array.isArray(p[`${ns}amr`]) ? (p[`${ns}amr`] as unknown[]) : []),
      ].filter((value): value is string => typeof value === "string"),
    ),
  ];
  const details = Array.isArray(p.authorization_details)
    ? (p.authorization_details as Array<Record<string, unknown>>)
    : [];
  // The Action records when MFA actually completed; standard auth_time can
  // still refer to an earlier primary login in the same Auth0 session.
  const factorTime = p[`${ns}auth_time`];
  const authTime =
    typeof factorTime === "number" &&
    Number.isFinite(factorTime) &&
    factorTime >= 0
      ? factorTime
      : typeof p.auth_time === "number" &&
          Number.isFinite(p.auth_time) &&
          p.auth_time >= 0
        ? p.auth_time
        : null;
  return {
    sub: String(p.sub),
    orgId: typeof p.org_id === "string" ? p.org_id : null,
    amr,
    acr:
      typeof p.acr === "string"
        ? p.acr
        : typeof p[`${ns}acr`] === "string"
          ? (p[`${ns}acr`] as string)
          : null,
    authTime,
    grants: [
      ...new Set([
        ...(Array.isArray(p.permissions) ? p.permissions.map(String) : []),
        ...(typeof p.scope === "string" ? p.scope.split(" ") : []).filter(
          Boolean,
        ),
      ]),
    ],
    iat: Number(p.iat),
    jti:
      typeof p.jti === "string"
        ? p.jti
        : typeof p[`${ns}decision_jti`] === "string"
          ? (p[`${ns}decision_jti`] as string)
          : null,
    authorizationDetails: details,
    approvalChallenge:
      typeof p[`${ns}approval_challenge`] === "string"
        ? (p[`${ns}approval_challenge`] as string)
        : null,
    actorType:
      p.sub_profile === "ai_agent" || (p.act && typeof p.act === "object")
        ? "agent"
        : "human",
    act:
      p.act && typeof p.act === "object"
        ? (p.act as Record<string, unknown>)
        : null,
  };
}

export async function authenticate(
  request: Request,
  config: ServiceConfig,
  now: number,
  db?: Db,
): Promise<Caller> {
  const token = request.headers
    .get("authorization")
    ?.match(
      /^(?:Bearer|DPoP) ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/,
    )?.[1];
  if (!token)
    throw new ServiceError("invalid_identity", "Bearer token required.");
  const { tenant, payload } = await verify(config, token, now);
  const cnf = payload.cnf as { jkt?: unknown } | undefined;
  let dpopJkt: string | null = null;
  if (
    cnf?.jkt !== undefined ||
    request.headers.get("authorization")?.startsWith("DPoP ")
  ) {
    try {
      if (
        typeof cnf?.jkt !== "string" ||
        !db ||
        !request.headers.get("authorization")?.startsWith("DPoP ")
      )
        throw new Error();
      const proof = request.headers.get("dpop");
      if (!proof) throw new Error();
      const header = decodeProtectedHeader(proof);
      if (
        header.typ !== "dpop+jwt" ||
        !header.jwk ||
        "d" in header.jwk ||
        !["ES256", "RS256", "PS256"].includes(String(header.alg))
      )
        throw new Error();
      const jkt = await calculateJwkThumbprint(header.jwk);
      if (jkt !== cnf.jkt) throw new Error();
      const key = await importJWK(header.jwk, header.alg);
      const { payload: claims } = await jwtVerify(proof, key, {
        algorithms: [String(header.alg)],
        currentDate: new Date(now),
        requiredClaims: ["iat", "jti"],
      });
      const target = new URL(request.url);
      target.search = "";
      target.hash = "";
      if (
        claims.htm !== request.method ||
        claims.htu !== target.href ||
        typeof claims.iat !== "number" ||
        Math.abs(now / 1000 - claims.iat) > 60 ||
        typeof claims.jti !== "string" ||
        claims.jti.length > 256 ||
        claims.ath !== createHash("sha256").update(token).digest("base64url")
      )
        throw new Error();
      // Proofs outside the +/-60s acceptance window can never replay: prune a bounded batch.
      await db.query(
        "delete from authority.used_dpop_proofs where ctid in (select ctid from authority.used_dpop_proofs where expires_at < $1 limit 100)",
        [new Date(now)],
      );
      const fresh = await db.query(
        "insert into authority.used_dpop_proofs (tenant_id,jkt,jti,expires_at) values ($1,$2,$3,$4) on conflict do nothing returning jti",
        [tenant.tenantId, jkt, claims.jti, new Date(now + 120000)],
      );
      if (!fresh.rowCount) throw new Error();
      dpopJkt = jkt;
    } catch {
      throw new ServiceError("invalid_identity", "DPoP proof rejected.");
    }
  }
  if (isClient(payload)) {
    const clientId = String(payload.azp ?? payload.client_id ?? "");
    if (!clientId)
      throw new ServiceError("invalid_identity", "Client identity missing.");
    const perms = new Set<string>([
      ...(Array.isArray(payload.permissions)
        ? payload.permissions.map(String)
        : []),
      ...String(payload.scope ?? "")
        .split(" ")
        .filter(Boolean),
    ]);
    let subject: Subject | null = null;
    const forwarded = request.headers.get(SUBJECT_HEADER);
    if (forwarded) {
      const v = await verify(config, forwarded, now, tenant);
      if (isClient(v.payload))
        throw new ServiceError("invalid_identity", "Subject must be a human.");
      subject = subjectFrom(v.payload, tenant.claimNamespace);
    }
    return {
      kind: "service",
      tenant,
      clientId,
      permissions: perms,
      subject,
      actorType:
        payload.sub_profile === "ai_agent" || payload.act ? "agent" : "service",
      act:
        payload.act && typeof payload.act === "object"
          ? (payload.act as Record<string, unknown>)
          : null,
    };
  }
  return {
    kind: "user",
    tenant,
    subject: { ...subjectFrom(payload, tenant.claimNamespace), dpopJkt },
  };
}

export function requirePermission(caller: Caller, permission: string) {
  if (caller.kind !== "service" || !caller.permissions.has(permission))
    throw new ServiceError(
      "not_authorized",
      "Caller lacks the required permission.",
    );
  return caller;
}

/**
 * Human callers have no service permissions; the equivalent is an explicit grant
 * (scope or RBAC permission) on their own signed token. FGA relations still apply on top.
 */
export function requireUserGrant(caller: Caller, grant: string) {
  if (caller.kind !== "user" || !caller.subject.grants.includes(grant))
    throw new ServiceError(
      "not_authorized",
      "Caller lacks the required permission.",
    );
  return caller;
}

/** Verifies a human access token for a known tenant (used for tokens the service itself obtained, e.g. via CIBA). */
export async function subjectFromAccessToken(
  config: ServiceConfig,
  tenant: TenantConfig,
  token: string,
  now: number,
): Promise<Subject> {
  const v = await verify(config, token, now, tenant);
  if (isClient(v.payload))
    throw new ServiceError("invalid_identity", "Subject must be a human.");
  return subjectFrom(v.payload, tenant.claimNamespace);
}
