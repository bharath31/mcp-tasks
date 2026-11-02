// Client for Auth0-style CIBA (RFC-style backchannel authentication, poll mode).
// Verified only against a local test provider.
export type CibaConfig = {
  bcAuthorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Audience of the access token the approver receives (the Task Authority API). */
  audience: string;
  issuer: string;
  /** Send RFC 9396 authorization_details (default). Auth0 needs the Highly Regulated Identity add-on for it. */
  rar?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class CibaUnavailable extends Error {}

const form = (o: Record<string, string>) => new URLSearchParams(o);

async function post(
  cfg: CibaConfig,
  url: string,
  body: Record<string, string>,
) {
  try {
    const res = await (cfg.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        ...body,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 5000),
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => ({}))) as Record<string, any>,
    };
  } catch {
    throw new CibaUnavailable("ciba_endpoint_unreachable");
  }
}

export async function startCiba(
  cfg: CibaConfig,
  a: {
    sub: string;
    message: string;
    details?: unknown[];
    requestedExpirySec?: number;
  },
) {
  const r = await post(cfg, cfg.bcAuthorizeUrl, {
    scope: "openid",
    requested_expiry: String(
      Math.max(1, Math.min(259200, Math.floor(a.requestedExpirySec ?? 300))),
    ),
    audience: cfg.audience,
    // Providers restrict binding messages to a small character set.
    binding_message: a.message
      .replace(/[^A-Za-z0-9 +\-_.,:#]/g, "")
      .slice(0, 64),
    login_hint: JSON.stringify({
      format: "iss_sub",
      iss: cfg.issuer,
      sub: a.sub,
    }),
    ...(a.details ? { authorization_details: JSON.stringify(a.details) } : {}),
  });
  if (r.status !== 200 || typeof r.json.auth_req_id !== "string")
    throw new CibaUnavailable(`bc_authorize_${r.status}`);
  return {
    authReqId: r.json.auth_req_id as string,
    expiresIn: Number(r.json.expires_in ?? 120),
    interval: Number(r.json.interval ?? 5),
  };
}

export type CibaPoll =
  | { state: "pending" }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "approved"; accessToken: string };

export async function pollCiba(
  cfg: CibaConfig,
  authReqId: string,
): Promise<CibaPoll> {
  const r = await post(cfg, cfg.tokenUrl, {
    grant_type: "urn:openid:params:grant-type:ciba",
    auth_req_id: authReqId,
  });
  if (r.status === 200 && typeof r.json.access_token === "string")
    return { state: "approved", accessToken: r.json.access_token };
  const e = String(r.json.error ?? "");
  if (e === "authorization_pending" || e === "slow_down")
    return { state: "pending" };
  if (e === "access_denied") return { state: "denied" };
  if (e === "expired_token" || e === "invalid_grant")
    return { state: "expired" };
  throw new CibaUnavailable(`token_${r.status}`);
}
