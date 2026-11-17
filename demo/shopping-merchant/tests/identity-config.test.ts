import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeShoppingIdentity,
  parseApiAudience,
  parseAuth0Domain,
  requireShoppingIdentity,
  shoppingIdentityConfigured,
} from "../src/identity/config.js";
import { TEST_AUDIENCE, TEST_DOMAIN } from "./support/identity-jwt.js";

test("parseAuth0Domain accepts tenant and custom domains", () => {
  assert.equal(parseAuth0Domain(TEST_DOMAIN), TEST_DOMAIN);
  assert.equal(parseAuth0Domain("login.brand.example"), "login.brand.example");
  assert.equal(parseAuth0Domain(`  ${TEST_DOMAIN}  `), TEST_DOMAIN);
});

test("parseAuth0Domain rejects URL shapes, localhost, IP, and whitespace", () => {
  const rejected = [
    "https://tenant.auth0.com",
    "tenant.auth0.com/",
    "tenant.auth0.com:443",
    "user@tenant.auth0.com",
    "tenant .auth0.com",
    "localhost",
    "auth.localhost",
    "127.0.0.1",
    "192.168.0.1",
    "",
    "   ",
  ];
  for (const value of rejected) {
    assert.equal(parseAuth0Domain(value), null, `expected reject: ${value}`);
  }
});

test("parseApiAudience accepts identifiers and https origins", () => {
  assert.equal(parseApiAudience(TEST_AUDIENCE), TEST_AUDIENCE);
  assert.equal(parseApiAudience(`  ${TEST_AUDIENCE}  `), TEST_AUDIENCE);
  assert.equal(
    parseApiAudience("urn:nominee:shopping-api"),
    "urn:nominee:shopping-api",
  );
});

test("parseApiAudience rejects malformed values", () => {
  assert.equal(parseApiAudience("https://user:pass@api.example"), null);
  assert.equal(parseApiAudience("not a url"), null);
  assert.equal(parseApiAudience("https://["), null);
  assert.equal(parseApiAudience(""), null);
});

test("normalizeShoppingIdentity trims env and requireShoppingIdentity returns canonical values", () => {
  const env = {
    SHOPPING_AUTH0_DOMAIN: `  ${TEST_DOMAIN}  `,
    SHOPPING_API_AUDIENCE: ` ${TEST_AUDIENCE} `,
  };
  assert.equal(shoppingIdentityConfigured(env), true);
  const normalized = normalizeShoppingIdentity(env);
  assert.deepEqual(normalized, {
    SHOPPING_AUTH0_DOMAIN: TEST_DOMAIN,
    SHOPPING_API_AUDIENCE: TEST_AUDIENCE,
  });
  assert.deepEqual(requireShoppingIdentity(env), normalized);
});

test("shopping identity stays unconfigured when domain or audience fails validation", () => {
  assert.equal(
    shoppingIdentityConfigured({
      SHOPPING_AUTH0_DOMAIN: "https://evil.example",
      SHOPPING_API_AUDIENCE: TEST_AUDIENCE,
    }),
    false,
  );
  assert.throws(
    () => requireShoppingIdentity({}),
    /shopping_identity_unconfigured/,
  );
});
