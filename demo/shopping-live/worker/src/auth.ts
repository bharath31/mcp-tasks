import { shoppingIdentityConfigured } from "../../../shopping-merchant/src/identity/config.js";
import { verifyCustomerAccessToken } from "../../../shopping-merchant/src/identity/index.js";
import type { CustomerAccessTokenDeps } from "../../../shopping-merchant/src/identity/customer-access-token.js";
import { OAUTH_COOKIE, type ShoppingLiveEnv } from "./env.js";
import {
  randomBase64Url,
  sha256Base64Url,
  signValue,
  verifySignedValue,
} from "./crypto-util.js";
import { json, problem, publicOrigin, secureCookieParts } from "./http.js";
import { mintSessionCookie } from "./session.js";
import { agentIntegrationConfigured } from "./agent-host.js";
import { guardianOrderExecutionEnabled } from "./order.js";
import { shoppingCibaConfigured } from "../../../shopping-merchant/src/ciba/config.js";

const OAUTH_TTL_MS = 5 * 60 * 1000;

type OAuthTx = {
  state: string;
  verifier: string;
  exp: number;
};

function oauthCookieHeader(
  value: string,
  origin: string,
  maxAge: number,
): string {
  return `${OAUTH_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=${maxAge}${secureCookieParts(origin)}`;
}

function authConfigured(env: ShoppingLiveEnv): boolean {
  return (
    shoppingIdentityConfigured(env) &&
    typeof env.SHOPPING_AUTH0_CLIENT_ID === "string" &&
    env.SHOPPING_AUTH0_CLIENT_ID.length > 0 &&
    typeof env.SHOPPING_AUTH0_CLIENT_SECRET === "string" &&
    env.SHOPPING_AUTH0_CLIENT_SECRET.length > 0 &&
    typeof env.SHOPPING_SESSION_SECRET === "string" &&
    env.SHOPPING_SESSION_SECRET.length >= 16
  );
}

export async function handleAuthLogin(
  req: Request,
  env: ShoppingLiveEnv,
): Promise<Response> {
  if (!authConfigured(env)) {
    return problem(
      503,
      "auth_unconfigured",
      "Customer sign-in is not configured.",
    );
  }
  const origin = publicOrigin(req, env);
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(48);
  const tx: OAuthTx = {
    state,
    verifier,
    exp: Date.now() + OAUTH_TTL_MS,
  };
  const signed = await signValue(
    env.SHOPPING_SESSION_SECRET!,
    JSON.stringify(tx),
  );
  const challenge = await sha256Base64Url(verifier);
  const redirectUri = `${origin}/auth/callback`;
  const authorize = new URL(`https://${env.SHOPPING_AUTH0_DOMAIN}/authorize`);
  authorize.searchParams.set("client_id", env.SHOPPING_AUTH0_CLIENT_ID!);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set(
    "scope",
    "openid profile offline_access shopping:customer",
  );
  authorize.searchParams.set("audience", env.SHOPPING_API_AUDIENCE);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.href,
      "cache-control": "no-store",
      "set-cookie": oauthCookieHeader(
        signed,
        origin,
        Math.floor(OAUTH_TTL_MS / 1000),
      ),
    },
  });
}

export async function handleAuthCallback(
  req: Request,
  env: ShoppingLiveEnv,
  deps: CustomerAccessTokenDeps = {},
): Promise<Response> {
  if (!authConfigured(env)) {
    return problem(
      503,
      "auth_unconfigured",
      "Customer sign-in is not configured.",
    );
  }
  const origin = publicOrigin(req, env);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieRaw = req.headers
    .get("cookie")
    ?.match(new RegExp(`(?:^|;\\s*)${OAUTH_COOKIE}=([^;]+)`))?.[1];
  if (!code || !state || !cookieRaw) {
    return problem(
      400,
      "invalid_oauth_callback",
      "OAuth callback is incomplete.",
    );
  }
  const txJson = await verifySignedValue(
    env.SHOPPING_SESSION_SECRET!,
    decodeURIComponent(cookieRaw),
  );
  if (!txJson) {
    return problem(
      400,
      "invalid_oauth_state",
      "OAuth transaction cookie is invalid.",
    );
  }
  let tx: OAuthTx;
  try {
    tx = JSON.parse(txJson) as OAuthTx;
  } catch {
    return problem(
      400,
      "invalid_oauth_state",
      "OAuth transaction cookie is invalid.",
    );
  }
  if (tx.state !== state || tx.exp <= Date.now()) {
    return problem(
      400,
      "invalid_oauth_state",
      "OAuth state expired or mismatched.",
    );
  }
  const redirectUri = `${origin}/auth/callback`;
  const tokenRes = await fetch(
    `https://${env.SHOPPING_AUTH0_DOMAIN}/oauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.SHOPPING_AUTH0_CLIENT_ID!,
        client_secret: env.SHOPPING_AUTH0_CLIENT_SECRET!,
        code,
        code_verifier: tx.verifier,
        redirect_uri: redirectUri,
      }),
      redirect: "manual",
    },
  );
  if (!tokenRes.ok) {
    return problem(
      503,
      "token_exchange_failed",
      "Auth0 token exchange failed.",
    );
  }
  const tokenBody = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!tokenBody.access_token) {
    return problem(503, "token_missing", "Auth0 returned no access token.");
  }
  const verified = await verifyCustomerAccessToken(
    env,
    tokenBody.access_token,
    deps,
  );
  if (!verified) {
    return problem(403, "token_rejected", "Access token failed verification.");
  }
  const expiresAtMs =
    Date.now() +
    (typeof tokenBody.expires_in === "number"
      ? tokenBody.expires_in * 1000
      : 3600_000);
  const setCookie = await mintSessionCookie(
    env,
    verified.customerId,
    tokenBody.access_token,
    expiresAtMs,
    origin,
  );
  const clearOAuth = oauthCookieHeader("", origin, 0);
  const headers = new Headers({
    location: `${origin}/`,
    "cache-control": "no-store",
  });
  headers.append("set-cookie", setCookie);
  headers.append("set-cookie", clearOAuth);
  return new Response(null, { status: 303, headers });
}

export async function handleAuthLogout(
  req: Request,
  env: ShoppingLiveEnv,
  deps: CustomerAccessTokenDeps = {},
): Promise<Response> {
  const { clearSessionCookie } = await import("./session.js");
  const origin = publicOrigin(req, env);
  const { clearCookie } = await clearSessionCookie(env, req, origin, deps);
  return new Response(null, {
    status: 303,
    headers: {
      location: `${origin}/`,
      "cache-control": "no-store",
      "set-cookie": clearCookie,
    },
  });
}

export function sessionPayload(
  req: Request,
  env: ShoppingLiveEnv,
  customer: { customerId: string } | null,
): Record<string, unknown> {
  const origin = publicOrigin(req, env);
  const authReady = authConfigured(env);
  const agentReady = agentIntegrationConfigured(env);
  return {
    authenticated: Boolean(customer),
    customerId: customer?.customerId,
    loginUrl: authReady ? `${origin}/auth/login` : undefined,
    logoutUrl: customer ? `${origin}/auth/logout` : undefined,
    merchant: {
      mode: env.SHOPPING_MERCHANT_WALLET_MODE === "live" ? "live" : "simulated",
      label: env.SHOPPING_MERCHANT_WALLET_LABEL ?? "Merchant wallet",
    },
    agentConnected: agentReady,
    capabilities: {
      agentRuns: agentReady,
      guardianApproval: shoppingCibaConfigured(env),
      orderExecute: guardianOrderExecutionEnabled(env),
    },
  };
}
