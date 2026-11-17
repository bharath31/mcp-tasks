import {
  normalizeShoppingIdentity,
  type ShoppingIdentityEnv,
} from "../identity/config.js";

/** Pinned Auth0 CIBA endpoints — only these URLs may be called for backchannel auth. */
export type ShoppingCibaEnv = ShoppingIdentityEnv & {
  SHOPPING_CIBA_CLIENT_ID: string;
  SHOPPING_CIBA_CLIENT_SECRET: string;
  SHOPPING_CIBA_BC_AUTHORIZE_URL: string;
  SHOPPING_CIBA_TOKEN_URL: string;
};

export type ShoppingCibaConfig = {
  bcAuthorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  audience: string;
  jwksDomain: string;
  timeoutMs: number;
};

const MAX_URL_LEN = 2048;

function pinnedHttpsUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > MAX_URL_LEN)
    return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (!url.hostname) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function nonEmptySecret(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  return trimmed;
}

/** Auth0 CIBA URLs must share the configured tenant origin and fixed paths. */
export function pinAuth0CibaEndpoint(
  raw: string | undefined,
  auth0Domain: string,
  path: "/bc-authorize" | "/oauth/token",
): string | null {
  const pinned = pinnedHttpsUrl(raw);
  if (!pinned) return null;
  try {
    const url = new URL(pinned);
    if (url.hostname !== auth0Domain) return null;
    const normalizedPath =
      url.pathname.length > 1 && url.pathname.endsWith("/")
        ? url.pathname.slice(0, -1)
        : url.pathname;
    if (normalizedPath !== path) return null;
    if (url.search || url.hash) return null;
    return `https://${auth0Domain}${path}`;
  } catch {
    return null;
  }
}

export function normalizeShoppingCiba(
  env: Partial<ShoppingCibaEnv>,
): ShoppingCibaConfig | null {
  const identity = normalizeShoppingIdentity(env);
  if (!identity) return null;
  const bcAuthorizeUrl = pinAuth0CibaEndpoint(
    env.SHOPPING_CIBA_BC_AUTHORIZE_URL,
    identity.SHOPPING_AUTH0_DOMAIN,
    "/bc-authorize",
  );
  const tokenUrl = pinAuth0CibaEndpoint(
    env.SHOPPING_CIBA_TOKEN_URL,
    identity.SHOPPING_AUTH0_DOMAIN,
    "/oauth/token",
  );
  const clientId = nonEmptySecret(env.SHOPPING_CIBA_CLIENT_ID);
  const clientSecret = nonEmptySecret(env.SHOPPING_CIBA_CLIENT_SECRET);
  if (!bcAuthorizeUrl || !tokenUrl || !clientId || !clientSecret) return null;
  return {
    bcAuthorizeUrl,
    tokenUrl,
    clientId,
    clientSecret,
    issuer: `https://${identity.SHOPPING_AUTH0_DOMAIN}/`,
    audience: identity.SHOPPING_API_AUDIENCE,
    jwksDomain: identity.SHOPPING_AUTH0_DOMAIN,
    timeoutMs: 10_000,
  };
}

export function shoppingCibaConfigured(env: Partial<ShoppingCibaEnv>): boolean {
  return normalizeShoppingCiba(env) !== null;
}
