import {
  generateKeyPair,
  importJWK,
  SignJWT,
  createLocalJWKSet,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";
import { SHOPPING_CUSTOMER_SCOPE } from "../../src/identity/config.js";

export const TEST_DOMAIN = "tenant.example.com";
export const TEST_ISSUER = `https://${TEST_DOMAIN}/`;
export const TEST_AUDIENCE = "https://shopping-api.example";
export const TEST_CUSTOMER = "auth0|customer-abc";

/** Fixed test key so Node outbounds and Miniflare Workers verify the same JWTs. */
export const SHOPPING_TEST_PUBLIC_JWK = {
  kty: "RSA",
  n: "5b61vaPRCN8Lbn-t4v9e0IPo5-pf7wwWyY2mczw7Ok8O7gm8pzDRDX88LoVPhsi_lSGbUuFgpWkw-X0LAoyci2yNnn5Bw5o5ck__zNt9Pc5VO2AInHdom8_DOXwkDd_KQ4sN7xtU2_3E1LjeHbDh-_Ji9joVuSAi_6sZLKdz3ldTSTbXWXQlYJATA7g2VC7kT9g2gg29-p7IDfWFoLtQqzfzTPl8kB8Fv2SPeD_IgTgS6EZT61LoQ_o7GzTQX7VM-eAQmk4_cOcr-OS8Mmy4xQWrcNoziItIYkr9w_lRnqw2zoZdgDxFH1LAykMb5ZzcZmp0tko0uEq-7V2Wev2e5w",
  e: "AQAB",
  alg: "RS256",
  kid: "shopping-test",
  use: "sig",
} satisfies JWK;

const FIXTURE_PRIVATE_JWK = {
  ...SHOPPING_TEST_PUBLIC_JWK,
  d: "JeEnSvC3FuzbkCj6DRrI0b1mCdLhZWMLYMj7oDVWmJsPXZz6X2CTn1OSoyL0xUbVG6wSVXx2eF9bJU-CILX5W52WzgKIKk2D2j6pcOfhgu7Bq8v-L3oao9ICILjAow76ZN-I-Rr7B1iUevROHvwajnVc7rcN_Nt5Gclmma-0UXypcykrsfYLVWWVJn2B0QqjkOl1ehccnnsVMIh2dM80De8zU4ZtrR3FUfsL1T-mw75x0cynCNKvNBCvjjdMOAACT0WZjkq9rPv9iUJ4YL-JRJfjhoQ3SulhmwVNa_cqxvDev92F7ZXcdulahFys9ADPQ8jjcccuVchouI3UqLZEEQ",
  p: "9Tpbk5u1QnHlPtEef7GAOLOiLsdt3aa7Sq821tQZQaDd1ATG56iDusmPrpPgwfrT00bOhz17uDZTj9TjCK-rrmBBj-XikUX5Q5RnnsY-ED87a_Nh9qj7Jy-hgV2EDq3WKpnT6-5rnsHmkp2aMyCYVYGminO4M7mUKLwW4hjgbPc",
  q: "79Y-EvH000kNiftcEoW4Z7Jo1uxNxJgszKnL3hHPEHJjSOES3Zn4ag-6zGROcOckrrD8lU_yB5sUtr5nbIPh__E-rJWRLFIBN0qnIPid0a8LmTx9WQ0tWNQEIaqwGAtkFh1_GM5pUU40e6chENb7R-UzMHRU5oU6g3QJuqkYkZE",
  dp: "vRIWgzM9SJKJ_qm7Cxbu1kjhlZGbipa_trBq5q23H1uJTKu2M-xATGaVijNnyge7BB2GpMzps7jnKnEn7o2LH7IFOo4y5nD943XrgoY0WdB23x9Se5wDsE3QBu70H2E2S7g4paI4hbnYLVioCB1sdhi1L_BSqEbADbwfJImrlzc",
  dq: "Im7O0Kd-L8tgLzwwNtSN6g1aMekRLTVv0R5bj5Fc-g6CJJdzvu75FDkX53pLLLhyssXkLYehxufD7IyfipvQmY9IIT0D76oCVK7aGci317_a2XAuytcyeHtP8Ilx6LHR977aXXRc-HhS3qHbBHDo-KR2WfGJsuLTyMWjE_Js_ZE",
  qi: "dUQ-Y1tZ2Lp8Cnq1CEQrcAboWxd-i1nAbFHHATjoeQw5m1M82M5Xg8_-Fr6glMoq70m021M_TXd9P3fksHorIUaEcZzUtw4ohYTRhK7_RZOoPYKAJ-Ppv4qPRLmNufKfKrxIyWP4BJfQcMV_nXdh8MSOvR1Pj69Xx15607DDTtc",
} satisfies JWK;

let testVerifyKey: JWTVerifyGetKey | undefined;
let testPrivateKey: CryptoKey | undefined;

export async function shoppingTestJwks(): Promise<JWTVerifyGetKey> {
  if (testVerifyKey) return testVerifyKey;
  testVerifyKey = createLocalJWKSet({ keys: [SHOPPING_TEST_PUBLIC_JWK] });
  testPrivateKey = (await importJWK(FIXTURE_PRIVATE_JWK, "RS256")) as CryptoKey;
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
