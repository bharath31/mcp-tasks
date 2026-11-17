import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { HumanActor } from "../types.js";
import {
  SHOPPING_CUSTOMER_SCOPE,
  shoppingIdentityConfigured,
  shoppingIssuer,
  type ShoppingIdentityEnv,
} from "./config.js";

export type VerifiedCustomer = {
  customerId: string;
  scopes: string[];
  payload: JWTPayload;
};

export type CustomerAccessTokenDeps = {
  /**
   * Test-only JWKS/key resolver; skips remote `.well-known/jwks.json`.
   * Never set in production Workers.
   */
  testVerifyKey?: JWTVerifyGetKey;
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const MAX_ACCESS_TOKEN_LEN = 16_384;

function parseScopes(scopeClaim: unknown): string[] | null {
  if (typeof scopeClaim !== "string" || !scopeClaim.trim()) return null;
  const scopes = scopeClaim.split(/\s+/).filter(Boolean);
  return scopes.length ? scopes : null;
}

function isMachineSubject(sub: string, payload: JWTPayload): boolean {
  if (payload.gty === "client-credentials") return true;
  if (sub.endsWith("@clients")) return true;
  return false;
}

function remoteJwks(domain: string) {
  const issuer = shoppingIssuer(domain);
  let cached = jwksCache.get(issuer);
  if (!cached) {
    cached = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
    jwksCache.set(issuer, cached);
  }
  return cached;
}

/** Extract a Bearer access token; does not validate. */
export const customerBearerToken = (req: Request) => {
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (
    !token ||
    token.length === 0 ||
    token.length > MAX_ACCESS_TOKEN_LEN
  ) {
    return null;
  }
  return token;
};

/**
 * Verify an Auth0 **access** token for the shopping API audience.
 * Fails closed on missing config, bad signature, wrong issuer/audience, machine tokens,
 * missing required claims/scopes, or expiry. Never treats a decodable JWT as trusted without
 * audience-bound API verification (ID tokens with a client `aud` are rejected).
 */
export async function verifyCustomerAccessToken(
  env: Partial<ShoppingIdentityEnv>,
  token: string,
  deps: CustomerAccessTokenDeps = {},
): Promise<VerifiedCustomer | null> {
  if (
    !shoppingIdentityConfigured(env) ||
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_ACCESS_TOKEN_LEN
  ) {
    return null;
  }
  const issuer = shoppingIssuer(env.SHOPPING_AUTH0_DOMAIN);
  const audience = env.SHOPPING_API_AUDIENCE;
  const key: JWTVerifyGetKey =
    deps.testVerifyKey ?? remoteJwks(env.SHOPPING_AUTH0_DOMAIN);
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer,
      audience,
      algorithms: ["RS256", "ES256", "PS256"],
      requiredClaims: ["sub", "exp", "iat"],
    });
    const sub = payload.sub;
    if (typeof sub !== "string" || sub.length === 0 || isMachineSubject(sub, payload)) {
      return null;
    }
    const scopes = parseScopes(payload.scope);
    if (!scopes || !scopes.includes(SHOPPING_CUSTOMER_SCOPE)) return null;
    return { customerId: sub, scopes, payload };
  } catch {
    return null;
  }
}

export function verifiedCustomerAsHumanActor(
  verified: VerifiedCustomer,
): HumanActor {
  return {
    kind: "human",
    customerId: verified.customerId,
    scopes: [...verified.scopes],
  };
}
