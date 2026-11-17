import assert from "node:assert/strict";
import { test } from "node:test";
import {
  customerBearerToken,
  verifyCustomerAccessToken,
  verifiedCustomerAsHumanActor,
  SHOPPING_CUSTOMER_SCOPE,
  shoppingIdentityConfigured,
} from "../src/identity/index.js";
import {
  mintCustomerAccessToken,
  shoppingTestJwks,
  testShoppingEnv,
  TEST_AUDIENCE,
  TEST_CUSTOMER,
} from "./support/identity-jwt.js";

test("shopping identity config is absent until domain and audience are set", () => {
  assert.equal(shoppingIdentityConfigured({}), false);
  assert.equal(
    shoppingIdentityConfigured({ SHOPPING_AUTH0_DOMAIN: "x.example.com" }),
    false,
  );
  assert.equal(shoppingIdentityConfigured(testShoppingEnv), true);
});

test("verifyCustomerAccessToken accepts a signed customer API access token", async () => {
  const jwks = await shoppingTestJwks();
  const token = await mintCustomerAccessToken();
  const verified = await verifyCustomerAccessToken(testShoppingEnv, token, {
    testVerifyKey: jwks,
  });
  assert.ok(verified);
  assert.equal(verified!.customerId, TEST_CUSTOMER);
  assert.ok(verified!.scopes.includes(SHOPPING_CUSTOMER_SCOPE));
  const human = verifiedCustomerAsHumanActor(verified!);
  assert.equal(human.kind, "human");
  assert.equal(human.customerId, TEST_CUSTOMER);
});

test("rejects invalid signature, issuer, audience, scope, and expiry", async () => {
  const jwks = await shoppingTestJwks();
  const deps = { testVerifyKey: jwks };
  const badSig = await mintCustomerAccessToken({ wrongKey: true });
  assert.equal(
    await verifyCustomerAccessToken(testShoppingEnv, badSig, deps),
    null,
  );
  const badIss = await mintCustomerAccessToken({
    issuer: "https://evil.example/",
  });
  assert.equal(
    await verifyCustomerAccessToken(testShoppingEnv, badIss, deps),
    null,
  );
  const badAud = await mintCustomerAccessToken({
    audience: "https://client-app-id",
  });
  assert.equal(
    await verifyCustomerAccessToken(testShoppingEnv, badAud, deps),
    null,
  );
  const noScope = await mintCustomerAccessToken({ scope: "openid" });
  assert.equal(
    await verifyCustomerAccessToken(testShoppingEnv, noScope, deps),
    null,
  );
  const expired = await mintCustomerAccessToken({ exp: "-1h" });
  assert.equal(
    await verifyCustomerAccessToken(testShoppingEnv, expired, deps),
    null,
  );
});

test("rejects machine tokens and unconfigured verifier", async () => {
  const jwks = await shoppingTestJwks();
  const deps = { testVerifyKey: jwks };
  const m2m = await mintCustomerAccessToken({
    sub: `${TEST_AUDIENCE}@clients`,
    gty: "client-credentials",
    scope: `${SHOPPING_CUSTOMER_SCOPE}`,
  });
  assert.equal(
    await verifyCustomerAccessToken(testShoppingEnv, m2m, deps),
    null,
  );
  const token = await mintCustomerAccessToken();
  assert.equal(await verifyCustomerAccessToken({}, token, deps), null);
});

test("customerBearerToken reads Authorization bearer only", () => {
  const ok = new Request("https://shop.example", {
    headers: { authorization: `Bearer tok-${TEST_CUSTOMER}` },
  });
  assert.equal(customerBearerToken(ok), `tok-${TEST_CUSTOMER}`);
  assert.equal(
    customerBearerToken(
      new Request("https://shop.example", {
        headers: { authorization: "DPoP x" },
      }),
    ),
    null,
  );
});
