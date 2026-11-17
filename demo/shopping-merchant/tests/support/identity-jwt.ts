import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  createLocalJWKSet,
  type JWTVerifyGetKey,
} from "jose";
import { SHOPPING_CUSTOMER_SCOPE } from "../../src/identity/config.js";

export const TEST_DOMAIN = "tenant.example.com";
export const TEST_ISSUER = `https://${TEST_DOMAIN}/`;
export const TEST_AUDIENCE = "https://shopping-api.example";
export const TEST_CUSTOMER = "auth0|customer-abc";

let testVerifyKey: JWTVerifyGetKey | undefined;
let testPrivateKey: CryptoKey | undefined;

export async function shoppingTestJwks(): Promise<JWTVerifyGetKey> {
  if (testVerifyKey) return testVerifyKey;
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "RS256";
  jwk.kid = "shopping-test";
  jwk.use = "sig";
  testVerifyKey = createLocalJWKSet({ keys: [jwk] });
  testPrivateKey = privateKey;
  return testVerifyKey;
}

async function testSigningKey(): Promise<CryptoKey> {
  await shoppingTestJwks();
  if (!testPrivateKey) throw new Error("test signing key missing");
  return testPrivateKey;
}

export type MintCustomerTokenOptions = {
  sub?: string;
  audience?: string | string[];
  issuer?: string;
  scope?: string;
  exp?: string;
  gty?: string;
  iat?: number;
  /** Sign with a different key to produce invalid signatures */
  wrongKey?: boolean;
};

export async function mintCustomerAccessToken(
  options: MintCustomerTokenOptions = {},
): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256");
  const key = options.wrongKey ? privateKey : await testSigningKey();
  const scope =
    options.scope ?? `${SHOPPING_CUSTOMER_SCOPE} openid profile offline_access`;
  const builder = new SignJWT({
    scope,
    ...(options.gty ? { gty: options.gty } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "shopping-test" })
    .setSubject(options.sub ?? TEST_CUSTOMER)
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.audience ?? TEST_AUDIENCE)
    .setIssuedAt(options.iat ?? Math.floor(Date.now() / 1000));
  if (options.exp) builder.setExpirationTime(options.exp);
  else builder.setExpirationTime("5m");
  return builder.sign(key);
}

export const testShoppingEnv = {
  SHOPPING_AUTH0_DOMAIN: TEST_DOMAIN,
  SHOPPING_API_AUDIENCE: TEST_AUDIENCE,
} as const;
