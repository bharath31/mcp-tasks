/** Server-only Auth0 CIBA client. Calls pinned HTTPS token and bc-authorize endpoints only. */

import type { ShoppingCibaConfig } from "./config.js";

export class ShoppingCibaClientError extends Error {
  readonly code:
    | "endpoint_unreachable"
    | "bc_authorize_rejected"
    | "token_rejected"
    | "unexpected_response";

  constructor(code: ShoppingCibaClientError["code"], message: string) {
    super(message);
    this.name = "ShoppingCibaClientError";
    this.code = code;
  }
}

export type CibaBackchannelStart = {
  authReqId: string;
  expiresInSec: number;
  intervalSec: number;
};

export type CibaTokenPoll =
  | { state: "pending"; intervalSec?: number }
  | { state: "slow_down"; intervalSec: number }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "approved"; accessToken: string; authorizationDetails: unknown[] };

export type ShoppingCibaClientDeps = {
  config: ShoppingCibaConfig;
  fetch?: typeof fetch;
};

const form = (fields: Record<string, string>) => new URLSearchParams(fields);

async function tlsPost(
  deps: ShoppingCibaClientDeps,
  url: string,
  body: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  if (url !== deps.config.bcAuthorizeUrl && url !== deps.config.tokenUrl) {
    throw new ShoppingCibaClientError(
      "unexpected_response",
      "Refusing CIBA call to an unpinned URL.",
    );
  }
  try {
    const res = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: deps.config.clientId,
        client_secret: deps.config.clientSecret,
        ...body,
      }),
      signal: AbortSignal.timeout(deps.config.timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return { status: res.status, json };
  } catch (e) {
    if (e instanceof ShoppingCibaClientError) throw e;
    throw new ShoppingCibaClientError(
      "endpoint_unreachable",
      "CIBA endpoint unreachable.",
    );
  }
}

export async function startShoppingCiba(
  deps: ShoppingCibaClientDeps,
  input: {
    customerSubject: string;
    bindingMessage: string;
    authorizationDetails: unknown[];
    requestedExpirySec?: number;
  },
): Promise<CibaBackchannelStart> {
  const requested = Math.max(
    1,
    Math.min(259_200, Math.floor(input.requestedExpirySec ?? 300)),
  );
  const r = await tlsPost(deps, deps.config.bcAuthorizeUrl, {
    scope: "openid",
    requested_expiry: String(requested),
    audience: deps.config.audience,
    binding_message: input.bindingMessage
      .replace(/[^A-Za-z0-9 +\-_.,:#]/g, "")
      .slice(0, 64),
    login_hint: JSON.stringify({
      format: "iss_sub",
      iss: deps.config.issuer,
      sub: input.customerSubject,
    }),
    authorization_details: JSON.stringify(input.authorizationDetails),
  });
  const authReqId = r.json.auth_req_id;
  if (r.status !== 200 || typeof authReqId !== "string" || !authReqId) {
    throw new ShoppingCibaClientError(
      "bc_authorize_rejected",
      `bc_authorize_${r.status}`,
    );
  }
  return {
    authReqId,
    expiresInSec: Number(r.json.expires_in ?? 120),
    intervalSec: Number(r.json.interval ?? 5),
  };
}

function readTopLevelAuthorizationDetails(
  json: Record<string, unknown>,
): unknown[] | null {
  const details = json.authorization_details;
  if (!Array.isArray(details)) return null;
  return details;
}

/**
 * Poll the pinned token endpoint with the server-held `auth_req_id`.
 * `authorization_details` are taken from the top-level OAuth JSON body only (Auth0 CIBA shape).
 */
export async function pollShoppingCibaToken(
  deps: ShoppingCibaClientDeps,
  authReqId: string,
): Promise<CibaTokenPoll> {
  const r = await tlsPost(deps, deps.config.tokenUrl, {
    grant_type: "urn:openid:params:grant-type:ciba",
    auth_req_id: authReqId,
  });
  const error = typeof r.json.error === "string" ? r.json.error : "";
  if (error === "authorization_pending") {
    return { state: "pending" };
  }
  if (error === "slow_down") {
    const intervalSec = Number(r.json.interval ?? 5);
    return {
      state: "slow_down",
      intervalSec: Number.isFinite(intervalSec) ? intervalSec : 5,
    };
  }
  if (error === "access_denied") return { state: "denied" };
  if (error === "expired_token" || error === "invalid_grant") {
    return { state: "expired" };
  }
  if (r.status !== 200 || typeof r.json.access_token !== "string") {
    throw new ShoppingCibaClientError("token_rejected", `token_${r.status}`);
  }
  const authorizationDetails = readTopLevelAuthorizationDetails(r.json);
  if (!authorizationDetails) {
    throw new ShoppingCibaClientError(
      "unexpected_response",
      "Approved CIBA response missing top-level authorization_details.",
    );
  }
  return {
    state: "approved",
    accessToken: r.json.access_token,
    authorizationDetails,
  };
}
