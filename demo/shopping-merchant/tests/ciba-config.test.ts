import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeShoppingCiba,
  pinAuth0CibaEndpoint,
} from "../src/ciba/config.js";

const DOMAIN = "tenant.auth0.com";

test("pinAuth0CibaEndpoint requires Auth0 domain origin and fixed paths", () => {
  assert.equal(
    pinAuth0CibaEndpoint(
      "https://tenant.auth0.com/bc-authorize",
      DOMAIN,
      "/bc-authorize",
    ),
    "https://tenant.auth0.com/bc-authorize",
  );
  assert.equal(
    pinAuth0CibaEndpoint(
      "https://evil.example/oauth/token",
      DOMAIN,
      "/oauth/token",
    ),
    null,
  );
  assert.equal(
    pinAuth0CibaEndpoint(
      "https://tenant.auth0.com/oauth/token?x=1",
      DOMAIN,
      "/oauth/token",
    ),
    null,
  );
});

test("normalizeShoppingCiba rejects token URL on wrong host", () => {
  const config = normalizeShoppingCiba({
    SHOPPING_AUTH0_DOMAIN: DOMAIN,
    SHOPPING_API_AUDIENCE: "https://api.example",
    SHOPPING_CIBA_CLIENT_ID: "cid",
    SHOPPING_CIBA_CLIENT_SECRET: "secret",
    SHOPPING_CIBA_BC_AUTHORIZE_URL: "https://tenant.auth0.com/bc-authorize",
    SHOPPING_CIBA_TOKEN_URL: "https://other.example/oauth/token",
  });
  assert.equal(config, null);
});
