import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { validateQuoteForGuardianDetails } from "../approval/validate.js";
import type { Quote } from "../types.js";
import { authorizationDetailsExactlyMatch } from "./canonical.js";
import type { ShoppingCibaConfig } from "./config.js";

export type CibaProofVerifierDeps = {
  config: ShoppingCibaConfig;
  /** Test hook — production uses JWKS from `jwksDomain`. */
  testVerifyKey?: JWTVerifyGetKey;
};

export class CibaProofRejected extends Error {
  readonly code:
    | "invalid_token"
    | "wrong_subject"
    | "wrong_audience"
    | "details_mismatch"
    | "quote_invalid"
    | "quote_expired";

  constructor(code: CibaProofRejected["code"], message: string) {
    super(message);
    this.name = "CibaProofRejected";
    this.code = code;
  }
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function resolveJwks(deps: CibaProofVerifierDeps): JWTVerifyGetKey | null {
  if (deps.testVerifyKey) return deps.testVerifyKey;
  const issuer = deps.config.issuer;
  let cached = jwksCache.get(issuer);
  if (!cached) {
    try {
      cached = createRemoteJWKSet(
        new URL(`https://${deps.config.jwksDomain}/.well-known/jwks.json`),
      );
    } catch {
      return null;
    }
    jwksCache.set(issuer, cached);
  }
  return cached;
}

export type VerifiedCibaApproval = {
  customerSubject: string;
  tokenId: string | null;
};

/**
 * Trust only a provider access token from the direct CIBA poll response plus
 * top-level `authorization_details` from that same response — never caller-supplied JSON.
 */
export async function verifyCibaApprovalProof(
  deps: CibaProofVerifierDeps,
  input: {
    accessToken: string;
    topLevelAuthorizationDetails: unknown[];
    expectedDetailsJson: string;
    expectedCustomerId: string;
    quote: Quote;
    nowMs: number;
  },
): Promise<VerifiedCibaApproval> {
  const key = resolveJwks(deps);
  if (!key) {
    throw new CibaProofRejected(
      "invalid_token",
      "JWKS unavailable for CIBA verification.",
    );
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(input.accessToken, key, {
      issuer: deps.config.issuer,
      audience: deps.config.audience,
      algorithms: ["RS256", "PS256", "ES256"],
    }));
  } catch {
    throw new CibaProofRejected(
      "invalid_token",
      "CIBA access token failed signature or claim checks.",
    );
  }
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub || sub !== input.expectedCustomerId) {
    throw new CibaProofRejected(
      "wrong_subject",
      "CIBA token subject does not match the challenged customer.",
    );
  }
  if (
    Array.isArray(payload.authorization_details) &&
    payload.authorization_details.length > 0
  ) {
    throw new CibaProofRejected(
      "details_mismatch",
      "Refusing JWT-embedded authorization_details; require top-level OAuth response.",
    );
  }
  if (
    !authorizationDetailsExactlyMatch(
      input.expectedDetailsJson,
      input.topLevelAuthorizationDetails,
    )
  ) {
    throw new CibaProofRejected(
      "details_mismatch",
      "Top-level authorization_details do not match the saved challenge.",
    );
  }
  try {
    validateQuoteForGuardianDetails(input.quote, input.nowMs);
  } catch (e) {
    const code =
      e instanceof Error &&
      "code" in e &&
      (e as { code: string }).code === "quote_expired"
        ? "quote_expired"
        : "quote_invalid";
    throw new CibaProofRejected(
      code,
      e instanceof Error ? e.message : "Quote revalidation failed.",
    );
  }
  return {
    customerSubject: sub,
    tokenId: typeof payload.jti === "string" ? payload.jti : null,
  };
}
