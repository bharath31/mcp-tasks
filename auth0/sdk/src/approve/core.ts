// approve(): a verified human decision as one step of a durable workflow.
//
// The proof of an approval is a token Auth0 signs, checked here against the tenant's
// public keys. No Task Authority service, FGA store or extra database is involved:
//
//   link (Auth0 Free) — the approver signs in again with a passkey (prompt=login,
//     max_age=0). The OIDC nonce is a hash of the request digest, run, step and
//     decision, so the ID token that comes back names exactly what was decided.
//   push (AI Agents add-on) — CIBA with authorization_details carrying the same
//     binding; the access token Auth0 issues is the proof.
//
// Verification happens inside the workflow after it resumes, against the workflow's
// own copy of the request. An event the engine accepted is input, never proof.
import {
  createRemoteJWKSet,
  customFetch,
  EncryptJWT,
  jwtDecrypt,
  jwtVerify,
  SignJWT,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json };

/** Who may decide. Anyone matching any entry qualifies; the requester never does. */
export type Approvers = {
  /** Auth0 user ids (`sub`). */
  users?: string[];
  /** The agent's owner, who may approve their own agent's actions. */
  owner?: string;
  /** Auth0 RBAC role names, read from the claim the approval Action sets. */
  roles?: string[];
};

export type Channel = "link" | "push";
export type Decision = "approve" | "reject";

export type ApprovalRequest = {
  v: 1;
  /** Stable for this run and step, so a retried step asks the same question. */
  id: string;
  action: string;
  resource: string;
  args: Record<string, Json>;
  /** Business-state version bound into the digest (e.g. the order's updated_at). */
  version?: string;
  /** sha256 of the canonical {v, action, resource, args, version}. */
  digest: string;
  run: string;
  step: string;
  approvers: Approvers;
  /** Optional human-readable labels for explicit approver user ids. */
  approverLabels?: Record<string, string>;
  /** The agent or workload asking. It can never approve its own request. */
  requester?: string;
  /** Optional DPoP thumbprint of the requesting agent, bound to the decision. */
  requesterJkt?: string;
  /** One human line for the page and the push notification. */
  summary?: string;
  via: Channel;
  /** Seconds since the epoch. */
  iat: number;
  exp: number;
};

export type Approval = {
  decision: Decision;
  approver: {
    sub: string;
    name?: string;
    email?: string;
    roles: string[];
    requiredRoles: string[];
  };
  /** How the approver proved presence: a fresh passkey sign-in, or a CIBA push. */
  method: "passkey" | "push";
  /** When the approver authenticated (seconds since the epoch). */
  at: number;
  /** Claims copied from the signed provider token for audit and policy integration. */
  amr: string[];
  orgId: string | null;
  tokenId: string | null;
  requestId: string;
  digest: string;
  /** Pass as the provider's idempotency key: a replayed step can't act twice. */
  key: string;
  /** The Auth0-signed token itself, for your audit log. */
  proof: string;
};

export type ApprovalConfig = {
  /** Auth0 tenant domain. Env: AUTH0_DOMAIN. */
  domain: string;
  /** A Regular Web Application. Env: AUTH0_CLIENT_ID. */
  clientId: string;
  /** Env: AUTH0_CLIENT_SECRET. Also keys the approval links unless linkSecret is set. */
  clientSecret: string;
  /** Public origin where the approval routes are mounted. Env: APP_URL. */
  appUrl: string;
  /** Auth0 connection name. Env: AUTH0_APPROVAL_CONNECTION. */
  connection?: string;
  /** Email OTP sign-in followed by WebAuthn MFA, or a passkey first factor. */
  loginMethod?: "passkey" | "email-otp";
  /** Default "/approve". */
  basePath?: string;
  /** API identifier for push approvals (CIBA needs one). Env: AUTH0_APPROVAL_AUDIENCE. */
  audience?: string;
  /** Default `https://${domain}/`. */
  issuer?: string;
  /** Env: APPROVAL_LINK_SECRET. */
  linkSecret?: string;
  /** Where the approval Action writes its claim. Default "https://task-authority.example/". */
  claimNamespace?: string;
  /** Allowed clock skew in seconds. Default 30. */
  clockSkew?: number;
  fetch?: typeof fetch;
};

export type ApprovalStore = {
  put(id: string, request: ApprovalRequest): Promise<void>;
  get(id: string): Promise<ApprovalRequest | undefined>;
};

export const AUTHORIZATION_DETAILS_TYPE = "agent_action";
export const DEFAULT_NAMESPACE = "https://task-authority.example/";

export class ApprovalError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "invalid_proof"
      | "wrong_request"
      | "not_an_approver"
      | "self_approval"
      | "no_passkey"
      | "stale"
      | "expired"
      | "rejected"
      | "provider_error",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

/** A verified rejection. The run should end without acting. */
export class ApprovalRejected extends ApprovalError {
  constructor(readonly approval: Approval) {
    super(
      "rejected",
      `Rejected by ${approval.approver.name ?? approval.approver.sub}.`,
    );
    this.name = "ApprovalRejected";
  }
}

export class ApprovalExpired extends ApprovalError {
  constructor(readonly requestId: string) {
    super(
      "expired",
      "No verified decision arrived before the request expired.",
    );
    this.name = "ApprovalExpired";
  }
}

const envString = (env: Record<string, unknown>, key: string) =>
  typeof env[key] === "string" && env[key] ? (env[key] as string) : undefined;

/** Code beats environment. Throws if a required value is missing. */
export function approvalConfig(
  env: Record<string, unknown> = {},
  overrides: Partial<ApprovalConfig> = {},
): ApprovalConfig {
  const cfg: Partial<ApprovalConfig> = {
    domain: envString(env, "AUTH0_DOMAIN"),
    clientId: envString(env, "AUTH0_CLIENT_ID"),
    clientSecret: envString(env, "AUTH0_CLIENT_SECRET"),
    appUrl: envString(env, "APP_URL"),
    connection: envString(env, "AUTH0_APPROVAL_CONNECTION"),
    loginMethod: envString(
      env,
      "AUTH0_APPROVAL_LOGIN_METHOD",
    ) as ApprovalConfig["loginMethod"],
    audience: envString(env, "AUTH0_APPROVAL_AUDIENCE"),
    linkSecret: envString(env, "APPROVAL_LINK_SECRET"),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v !== undefined),
    ),
  };
  const missing = (["domain", "clientId", "clientSecret", "appUrl"] as const)
    .filter((k) => !cfg[k])
    .map(
      (k) =>
        ({
          domain: "AUTH0_DOMAIN",
          clientId: "AUTH0_CLIENT_ID",
          clientSecret: "AUTH0_CLIENT_SECRET",
          appUrl: "APP_URL",
        })[k],
    );
  if (missing.length)
    throw new ApprovalError(
      "invalid_request",
      `Approval config is missing ${missing.join(", ")}.`,
    );
  if (
    (cfg.loginMethod && !["passkey", "email-otp"].includes(cfg.loginMethod)) ||
    (cfg.loginMethod === "email-otp" && !cfg.connection)
  )
    throw new ApprovalError(
      "invalid_request",
      "Email OTP approvals need AUTH0_APPROVAL_CONNECTION and AUTH0_APPROVAL_LOGIN_METHOD=email-otp.",
    );
  return cfg as ApprovalConfig;
}

export const issuerOf = (cfg: ApprovalConfig) =>
  cfg.issuer ??
  `https://${cfg.domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}/`;
const nsOf = (cfg: ApprovalConfig) => cfg.claimNamespace ?? DEFAULT_NAMESPACE;
const skewOf = (cfg: ApprovalConfig) => cfg.clockSkew ?? 30;
export const basePathOf = (cfg: ApprovalConfig) =>
  (cfg.basePath ?? "/approve").replace(/\/$/, "");

// ---------------------------------------------------------------------------
// Canonical form and digests

/**
 * Sorted object keys, no whitespace, safe integers only (money in minor units;
 * anything else as a string). The same rules as Task Authority's canonical form v1.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new ApprovalError(
        "invalid_request",
        "Arguments may only contain safe integers; use integer minor units or strings.",
      );
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
      .join(",")}}`;
  }
  throw new ApprovalError("invalid_request", "Unsupported argument value.");
}

const bytes = (s: string) => new TextEncoder().encode(s);
async function sha256(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(text)));
}
const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64url = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export async function actionDigest(p: {
  action: string;
  resource: string;
  args: Record<string, Json>;
  version?: string;
}) {
  return `sha256:${hex(
    await sha256(
      canonicalize({
        v: 1,
        action: p.action,
        resource: p.resource,
        args: p.args,
        version: p.version,
      }),
    ),
  )}`;
}

/** What the OIDC nonce (link) or authorization_details (push) must carry. */
export async function approvalBinding(r: ApprovalRequest, decision: Decision) {
  return b64url(
    await sha256(
      `agent-approval:v1|${canonicalize({
        id: r.id,
        digest: r.digest,
        run: r.run,
        step: r.step,
        exp: r.exp,
        requesterJkt: r.requesterJkt,
        decision,
      })}`,
    ),
  );
}

/** Stable per request: the same run and step always produce the same key. */
export async function approvalKey(r: ApprovalRequest) {
  return `apv_${hex(await sha256(`${r.id}|${r.digest}`)).slice(0, 40)}`;
}

/** Parses "30m", "2h", "7 days", "90 seconds", or milliseconds. */
export function durationMs(d: string | number): number {
  if (typeof d === "number") return d;
  const m = d
    .trim()
    .match(
      /^(\d+)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hours?|d|days?)$/i,
    );
  if (!m) throw new ApprovalError("invalid_request", `Bad duration "${d}".`);
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  if (u === "ms") return n;
  if (u.startsWith("s")) return n * 1000;
  if (u.startsWith("m")) return n * 60_000;
  if (u.startsWith("h")) return n * 3_600_000;
  return n * 86_400_000;
}

export type ApprovalInput = {
  /** Optional externally assigned id when a service owns the approval row. */
  id?: string;
  action: string;
  resource: string;
  args: Record<string, Json>;
  version?: string;
  approvers: Approvers;
  approverLabels?: Record<string, string>;
  requester?: string;
  requesterJkt?: string;
  summary?: string;
  /** Default "link". */
  via?: Channel;
  /** Default "30m". Push is capped by Auth0 at 72 hours. */
  expiresIn?: string | number;
};

export async function createApprovalRequest(
  input: ApprovalInput & { run: string; step: string; now?: number },
): Promise<ApprovalRequest> {
  const approvers: Approvers = {
    ...(input.approvers.users?.length ? { users: input.approvers.users } : {}),
    ...(input.approvers.owner ? { owner: input.approvers.owner } : {}),
    ...(input.approvers.roles?.length ? { roles: input.approvers.roles } : {}),
  };
  if (!Object.keys(approvers).length)
    throw new ApprovalError("invalid_request", "Name at least one approver.");
  const via = input.via ?? "link";
  if (
    via === "push" &&
    (named(approvers).length > 1 ||
      (named(approvers).length !== 1 && !approvers.roles))
  )
    throw new ApprovalError(
      "invalid_request",
      "A push goes to one person: name exactly one user or the owner.",
    );
  if (!input.run || !input.step)
    throw new ApprovalError("invalid_request", "run and step are required.");
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const ttl = Math.ceil(durationMs(input.expiresIn ?? "30m") / 1000);
  // Snapshot caller-owned arguments before hashing so the displayed request and
  // its digest cannot diverge if the caller mutates the original object later.
  const args = JSON.parse(canonicalize(input.args)) as Record<string, Json>;
  const digest = await actionDigest({ ...input, args });
  return {
    v: 1,
    id:
      input.id ??
      `apr_${hex(await sha256(`${input.run}|${input.step}`)).slice(0, 32)}`,
    action: input.action,
    resource: input.resource,
    args,
    ...(input.version !== undefined ? { version: input.version } : {}),
    digest,
    run: input.run,
    step: input.step,
    approvers,
    ...(input.approverLabels
      ? { approverLabels: { ...input.approverLabels } }
      : {}),
    ...(input.requester ? { requester: input.requester } : {}),
    ...(input.requesterJkt ? { requesterJkt: input.requesterJkt } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    via,
    iat,
    exp: iat + ttl,
  };
}

const named = (a: Approvers) => [
  ...(a.users ?? []),
  ...(a.owner ? [a.owner] : []),
];

// ---------------------------------------------------------------------------
// Links and login state. Keys derive from the client secret, so setup adds no secret.

const keyCache = new Map<string, Promise<Uint8Array>>();
function derivedKey(cfg: ApprovalConfig, purpose: "link" | "state") {
  const secret = cfg.linkSecret ?? cfg.clientSecret;
  const id = `${purpose}|${secret}`;
  let k = keyCache.get(id);
  if (!k) {
    k = (async () => {
      const base = await crypto.subtle.importKey(
        "raw",
        bytes(secret),
        "HKDF",
        false,
        ["deriveBits"],
      );
      return new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: bytes("agent-approval"),
            info: bytes(purpose),
          },
          base,
          256,
        ),
      );
    })();
    keyCache.set(id, k);
  }
  return k;
}

/** The link the approver opens. Signed, so only this app can mint approval pages. */
export async function approvalLink(
  cfg: ApprovalConfig,
  r: ApprovalRequest,
  store?: ApprovalStore,
) {
  const token = await new SignJWT({ r })
    .setProtectedHeader({ alg: "HS256", typ: "approval-request" })
    .setIssuedAt(r.iat)
    .setExpirationTime(r.exp)
    .sign(await derivedKey(cfg, "link"));
  const url = new URL(`${basePathOf(cfg)}`, cfg.appUrl);
  url.searchParams.set("r", token);
  if (url.toString().length > 6 * 1024) {
    if (!store)
      throw new ApprovalError(
        "invalid_request",
        "This approval request is too large for a link. Configure an approval store.",
      );
    await store.put(r.id, r);
    const pointer = await new SignJWT({ i: r.id })
      .setProtectedHeader({ alg: "HS256", typ: "approval-pointer" })
      .setIssuedAt(r.iat)
      .setExpirationTime(r.exp)
      .sign(await derivedKey(cfg, "link"));
    url.search = "";
    url.searchParams.set("r", `@${pointer}`);
  }
  return url.toString();
}

export async function readApprovalLink(
  cfg: ApprovalConfig,
  token: string,
  now = Date.now(),
  store?: ApprovalStore,
): Promise<ApprovalRequest> {
  if (token.startsWith("@")) {
    if (!store)
      throw new ApprovalError(
        "invalid_request",
        "This approval link is not valid.",
      );
    let id: unknown;
    try {
      const { payload } = await jwtVerify(
        token.slice(1),
        await derivedKey(cfg, "link"),
        {
          algorithms: ["HS256"],
          typ: "approval-pointer",
          currentDate: new Date(now),
        },
      );
      id = payload.i;
    } catch (e) {
      if (
        e instanceof Error &&
        /exp/i.test((e as { code?: string }).code ?? "")
      )
        throw new ApprovalError(
          "expired",
          "This approval request has expired.",
        );
      throw new ApprovalError(
        "invalid_request",
        "This approval link is not valid.",
      );
    }
    if (typeof id !== "string" || !id)
      throw new ApprovalError(
        "invalid_request",
        "This approval link is not valid.",
      );
    const request = await store.get(id);
    if (!request || request.id !== id)
      throw new ApprovalError(
        "invalid_request",
        "This approval link is not valid.",
      );
    if (request.exp <= Math.floor(now / 1000))
      throw new ApprovalError("expired", "This approval request has expired.");
    return request;
  }
  try {
    const { payload } = await jwtVerify(token, await derivedKey(cfg, "link"), {
      algorithms: ["HS256"],
      typ: "approval-request",
      currentDate: new Date(now),
    });
    return payload.r as ApprovalRequest;
  } catch (e) {
    if (e instanceof Error && /exp/i.test((e as { code?: string }).code ?? ""))
      throw new ApprovalError("expired", "This approval request has expired.");
    throw new ApprovalError(
      "invalid_request",
      "This approval link is not valid.",
    );
  }
}

/** Re-check that the approver still has one of the required Auth0 roles. */
export function auth0RolesRecheck(
  cfg: ApprovalConfig,
  mgmtToken: string,
): (approval: Approval) => Promise<boolean> {
  return async (approval) => {
    if (!approval.approver.requiredRoles.length) return true;
    const res = await (cfg.fetch ?? fetch)(
      new URL(
        `api/v2/users/${encodeURIComponent(approval.approver.sub)}/roles`,
        issuerOf(cfg),
      ),
      { headers: { authorization: `Bearer ${mgmtToken}` } },
    );
    if (!res.ok)
      throw new ApprovalError(
        "provider_error",
        `Could not re-check the approver's roles (${res.status}).`,
      );
    const roles = (await res.json()) as { name?: unknown }[];
    const currentRoles = new Set(
      (Array.isArray(roles) ? roles : [])
        .map((role) => role.name)
        .filter((name): name is string => typeof name === "string"),
    );
    return approval.approver.requiredRoles.some((role) =>
      currentRoles.has(role),
    );
  };
}

export type LoginState = { r: string; d: Decision; cv: string };

export async function sealState(cfg: ApprovalConfig, s: LoginState) {
  return new EncryptJWT({ ...s })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .encrypt(await derivedKey(cfg, "state"));
}

export async function openState(cfg: ApprovalConfig, token: string) {
  try {
    const { payload } = await jwtDecrypt(token, await derivedKey(cfg, "state"));
    return payload as unknown as LoginState;
  } catch {
    throw new ApprovalError(
      "invalid_request",
      "The sign-in took too long or the link was altered. Open the approval link again.",
    );
  }
}

/** Auth0 /authorize for one decision on one request. */
export async function authorizeUrl(
  cfg: ApprovalConfig,
  r: ApprovalRequest,
  decision: Decision,
  state: string,
  codeChallenge: string,
) {
  const url = new URL("authorize", issuerOf(cfg));
  const q = url.searchParams;
  q.set("response_type", "code");
  q.set("client_id", cfg.clientId);
  q.set("redirect_uri", callbackUrl(cfg));
  q.set("scope", "openid profile email");
  q.set("prompt", "login");
  q.set("max_age", "0");
  q.set("nonce", await approvalBinding(r, decision));
  q.set("state", state);
  q.set("code_challenge", codeChallenge);
  q.set("code_challenge_method", "S256");
  // Tells the approval Action to require a passkey and stamp its claim.
  q.set("agent_approval", cfg.loginMethod === "email-otp" ? "mfa" : "1");
  if (cfg.connection) q.set("connection", cfg.connection);
  return url.toString();
}

export const callbackUrl = (cfg: ApprovalConfig) =>
  new URL(`${basePathOf(cfg)}/callback`, cfg.appUrl).toString();

export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64url(await sha256(verifier)) };
}

// ---------------------------------------------------------------------------
// Verification

const jwksCache = new Map<string, JWTVerifyGetKey>();
function jwksOf(cfg: ApprovalConfig) {
  const iss = issuerOf(cfg);
  let k = jwksCache.get(iss);
  if (!k) {
    k = createRemoteJWKSet(
      new URL(".well-known/jwks.json", iss),
      cfg.fetch ? { [customFetch]: cfg.fetch } : {},
    );
    jwksCache.set(iss, k);
  }
  return k;
}

type ApprovalClaim = {
  method?: string;
  factor?: string;
  at?: number;
  roles?: unknown;
};

/**
 * Checks a proof against the workflow's own request and returns the decision.
 * Throws ApprovalError when the proof doesn't prove this decision on this request.
 * A verified rejection is returned (decision "reject"), not thrown.
 */
export async function verifyApproval(
  cfg: ApprovalConfig,
  r: ApprovalRequest,
  proof: unknown,
  now = Date.now(),
): Promise<Approval> {
  if (typeof proof !== "string" || proof.split(".").length !== 3)
    throw new ApprovalError("invalid_proof", "The decision carried no proof.");
  const nowS = Math.floor(now / 1000);
  const skew = skewOf(cfg);
  const audience = r.via === "push" ? cfg.audience : cfg.clientId;
  if (!audience)
    throw new ApprovalError(
      "invalid_request",
      "Push approvals need AUTH0_APPROVAL_AUDIENCE to verify.",
    );
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(proof, jwksOf(cfg), {
      issuer: issuerOf(cfg),
      audience,
      algorithms: ["RS256", "PS256", "ES256"],
      clockTolerance: skew,
      currentDate: new Date(now),
    }));
  } catch (e) {
    // A JOSE error means the token is bad. Anything else (the JWKS fetch failed, a
    // timeout) says nothing about the token, so let the step retry.
    const code = (e as { code?: unknown })?.code;
    if (
      typeof code !== "string" ||
      !code.startsWith("ERR_J") ||
      code === "ERR_JWKS_TIMEOUT"
    )
      throw new ApprovalError(
        "provider_error",
        "Could not fetch this tenant's signing keys.",
      );
    throw new ApprovalError(
      "invalid_proof",
      "The proof is not a valid token from this Auth0 tenant.",
    );
  }
  const sub = String(payload.sub ?? "");
  let decision: Decision | undefined;
  let method: Approval["method"];
  let at: number;
  if (r.via === "link") {
    for (const d of ["approve", "reject"] as const)
      if (payload.nonce === (await approvalBinding(r, d))) decision = d;
    if (!decision)
      throw new ApprovalError(
        "wrong_request",
        "The proof is for a different action, arguments, run or step.",
      );
    at = Number(payload.auth_time);
    if (!Number.isFinite(at) || at < r.iat - skew || at > nowS + skew)
      throw new ApprovalError(
        "stale",
        "The approver did not sign in after the request was made.",
      );
    const claim = payload[`${nsOf(cfg)}approval`] as ApprovalClaim | undefined;
    const webauthnMfa =
      claim?.factor === "webauthn-platform" ||
      claim?.factor === "webauthn-roaming";
    if (
      claim?.method !== "passkey" ||
      typeof claim.at !== "number" ||
      !Number.isFinite(claim.at) ||
      claim.at < r.iat - skew ||
      claim.at > nowS + skew ||
      (claim.factor === undefined
        ? Math.abs(claim.at - at) > skew
        : !webauthnMfa || claim.at < at)
    )
      throw new ApprovalError(
        "no_passkey",
        "The approver did not sign in with a passkey for this approval.",
      );
    at = claim.at;
    method = "passkey";
  } else {
    const details = Array.isArray(payload.authorization_details)
      ? (payload.authorization_details as Record<string, unknown>[])
      : [];
    const mine = details.find((d) => d?.type === AUTHORIZATION_DETAILS_TYPE);
    // CIBA has no "reject" token: a denial ends at the token endpoint with access_denied.
    if (!mine || mine.binding !== (await approvalBinding(r, "approve")))
      throw new ApprovalError(
        "wrong_request",
        "The proof is for a different action, arguments, run or step.",
      );
    decision = "approve";
    at = Number(payload.iat);
    if (!Number.isFinite(at) || at < r.iat - skew)
      throw new ApprovalError("stale", "The proof predates the request.");
    method = "push";
  }
  if (at > r.exp + skew)
    throw new ApprovalError(
      "expired",
      "The decision came after the request expired.",
    );
  if (r.requester && sub === r.requester)
    throw new ApprovalError(
      "self_approval",
      "The requester cannot approve its own request.",
    );
  const claim = (payload[`${nsOf(cfg)}approval`] ?? {}) as ApprovalClaim;
  const roles = Array.isArray(claim.roles)
    ? claim.roles.filter((x): x is string => typeof x === "string")
    : [];
  const allowed =
    named(r.approvers).includes(sub) ||
    (r.approvers.roles ?? []).some((role) => roles.includes(role));
  if (!allowed)
    throw new ApprovalError(
      "not_an_approver",
      "This person is not allowed to decide this request.",
    );
  return {
    decision,
    approver: {
      sub,
      ...(typeof payload.name === "string" ? { name: payload.name } : {}),
      ...(typeof payload.email === "string" ? { email: payload.email } : {}),
      roles,
      requiredRoles: r.approvers.roles ?? [],
    },
    method,
    at,
    amr: Array.isArray(payload.amr)
      ? payload.amr.filter((x): x is string => typeof x === "string")
      : [],
    orgId: typeof payload.org_id === "string" ? payload.org_id : null,
    tokenId: typeof payload.jti === "string" ? payload.jti : null,
    requestId: r.id,
    digest: r.digest,
    key: await approvalKey(r),
    proof,
  };
}

/** Verifies, then turns a verified rejection into ApprovalRejected. */
export async function requireApproval(
  cfg: ApprovalConfig,
  r: ApprovalRequest,
  proof: unknown,
  now?: number,
) {
  const a = await verifyApproval(cfg, r, proof, now);
  if (a.decision !== "approve") throw new ApprovalRejected(a);
  return a;
}

// ---------------------------------------------------------------------------
// OAuth calls

async function tokenCall(cfg: ApprovalConfig, body: Record<string, string>) {
  const res = await (cfg.fetch ?? fetch)(
    new URL("oauth/token", issuerOf(cfg)),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        ...body,
      }),
    },
  );
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

export async function exchangeCode(
  cfg: ApprovalConfig,
  code: string,
  verifier: string,
) {
  const { ok, json } = await tokenCall(cfg, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: callbackUrl(cfg),
  });
  if (!ok || typeof json.id_token !== "string")
    throw new ApprovalError(
      "provider_error",
      `Auth0 did not return an ID token (${String(json.error ?? "unknown")}).`,
    );
  return json.id_token;
}

/** Auth0 limits binding_message to 64 characters from a small alphabet. */
export function bindingMessage(r: ApprovalRequest) {
  const text = (r.summary ?? `${r.action} ${r.resource}`)
    .replace(/[^A-Za-z0-9 +\-_.,:#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 64 ? `${text.slice(0, 61).trimEnd()}...` : text;
}

export type PushStart = {
  authReqId: string;
  interval: number;
  expiresIn: number;
};

/** Sends the CIBA request. Needs the AI Agents add-on and `audience`. */
export async function startPush(
  cfg: ApprovalConfig,
  r: ApprovalRequest,
  resolveApprover?: (request: ApprovalRequest) => Promise<string>,
): Promise<PushStart> {
  if (r.via !== "push" || !cfg.audience)
    throw new ApprovalError(
      "invalid_request",
      'Push approvals need via: "push" and AUTH0_APPROVAL_AUDIENCE.',
    );
  const sub = named(r.approvers)[0] ?? (await resolveApprover?.(r));
  if (!sub)
    throw new ApprovalError(
      "invalid_request",
      "Push approvals need one named approver or a resolveApprover function.",
    );
  const res = await (cfg.fetch ?? fetch)(
    new URL("bc-authorize", issuerOf(cfg)),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: "openid",
        audience: cfg.audience,
        binding_message: bindingMessage(r),
        login_hint: JSON.stringify({
          format: "iss_sub",
          iss: issuerOf(cfg),
          sub,
        }),
        requested_expiry: String(
          Math.max(1, r.exp - Math.floor(Date.now() / 1000)),
        ),
        authorization_details: JSON.stringify([
          {
            type: AUTHORIZATION_DETAILS_TYPE,
            binding: await approvalBinding(r, "approve"),
            digest: r.digest,
            action: r.action,
            resource: r.resource,
          },
        ]),
      }),
    },
  );
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.auth_req_id !== "string")
    throw new ApprovalError(
      "provider_error",
      `Auth0 refused the push request (${String(json.error ?? res.status)}).`,
    );
  return {
    authReqId: json.auth_req_id,
    interval: Number(json.interval ?? 5),
    expiresIn: Number(json.expires_in ?? r.exp - r.iat),
  };
}

export type PushPoll =
  | { status: "pending"; interval?: number }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; proof: string };

export async function pollPush(
  cfg: ApprovalConfig,
  authReqId: string,
): Promise<PushPoll> {
  const { ok, json } = await tokenCall(cfg, {
    grant_type: "urn:openid:params:grant-type:ciba",
    auth_req_id: authReqId,
  });
  if (ok && typeof json.access_token === "string")
    return { status: "approved", proof: json.access_token };
  if (json.error === "authorization_pending") return { status: "pending" };
  if (json.error === "slow_down") return { status: "pending", interval: 10 };
  if (json.error === "access_denied") return { status: "denied" };
  if (json.error === "expired_token") return { status: "expired" };
  throw new ApprovalError(
    "provider_error",
    `Auth0 push polling failed (${String(json.error ?? "unknown")}).`,
  );
}
