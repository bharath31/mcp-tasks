// Local stand-in for an Auth0 tenant's token issuer. Tokens are real signed JWTs
// verified through the same code path as production (jose + JWKS); only the
// issuer is local. This is NOT a live Auth0 integration.
import {
  importJWK,
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";
import type { Clock } from "./clock.js";

export type MintOptions = {
  sub: string;
  orgId?: string;
  mfa?: boolean;
  authTime?: number | null;
  azp?: string;
  m2m?: boolean;
  permissions?: readonly string[];
  details?: Array<Record<string, unknown>>;
  jti?: string;
  ttlSec?: number;
  audience?: string;
  issuer?: string;
  iat?: number;
  /** Extra raw claims (e.g. namespaced assurance claims). */
  claims?: Record<string, unknown>;
};

export class TestIdp {
  private constructor(
    readonly issuer: string,
    readonly audience: string,
    private privateKey: CryptoKey,
    readonly keys: JWTVerifyGetKey,
    private clock: Clock,
    readonly jwk: JWK,
    readonly privateJwk?: JWK,
  ) {}
  /** Rebuild an issuer in another process from exported keys (restart tests). */
  static async restore(
    privateJwk: JWK,
    publicJwk: JWK,
    clock: Clock,
    issuer = "https://test-tenant.example/",
    audience = "https://task-authority.example/api",
  ) {
    const key = (await importJWK(privateJwk, "RS256")) as CryptoKey;
    return new TestIdp(
      issuer,
      audience,
      key,
      createLocalJWKSet({ keys: [publicJwk] }),
      clock,
      publicJwk,
      privateJwk,
    );
  }
  static async create(
    clock: Clock,
    issuer = "https://test-tenant.example/",
    audience = "https://task-authority.example/api",
  ) {
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const jwk: JWK = {
      ...(await exportJWK(publicKey)),
      alg: "RS256",
      use: "sig",
      kid: "k1",
    };
    return new TestIdp(
      issuer,
      audience,
      privateKey,
      createLocalJWKSet({ keys: [jwk] }),
      clock,
      jwk,
      await exportJWK(privateKey),
    );
  }
  async mint(o: MintOptions): Promise<string> {
    const iat = o.iat ?? this.clock.seconds;
    const claims: Record<string, unknown> = {};
    if (o.orgId) claims.org_id = o.orgId;
    Object.assign(claims, o.claims);
    if (o.azp && !o.m2m) claims.azp = o.azp;
    if (o.mfa && !o.claims?.amr) claims.amr = ["pwd", "mfa", "otp"];
    if (o.authTime !== null && o.authTime !== undefined)
      claims.auth_time = o.authTime;
    else if (o.authTime === undefined && !o.m2m) claims.auth_time = iat;
    if (o.details) claims.authorization_details = o.details;
    if (o.m2m) {
      claims.gty = "client-credentials";
      claims.azp = o.azp ?? o.sub.replace(/@clients$/, "");
      claims.permissions = o.permissions ?? [];
    }
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: this.jwk.kid ?? "k1" })
      .setIssuer(o.issuer ?? this.issuer)
      .setAudience(o.audience ?? this.audience)
      .setSubject(o.sub)
      .setIssuedAt(iat)
      .setExpirationTime(iat + (o.ttlSec ?? 3600))
      .setJti(o.jti ?? crypto.randomUUID())
      .sign(this.privateKey);
  }
  service(clientId: string, permissions: readonly string[]) {
    return this.mint({
      sub: `${clientId}@clients`,
      azp: clientId,
      m2m: true,
      permissions,
    });
  }
  /** A foreign issuer with its own keys, to prove issuer pinning. */
  async foreign(o: MintOptions) {
    const { privateKey } = await generateKeyPair("RS256");
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: this.jwk.kid ?? "k1" })
      .setIssuer(o.issuer ?? this.issuer)
      .setAudience(o.audience ?? this.audience)
      .setSubject(o.sub)
      .setIssuedAt(this.clock.seconds)
      .setExpirationTime(this.clock.seconds + 3600)
      .sign(privateKey);
  }
}
