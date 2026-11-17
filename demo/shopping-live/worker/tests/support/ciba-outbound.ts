import {
  mintCustomerAccessToken,
  SHOPPING_TEST_PUBLIC_JWK,
  TEST_DOMAIN,
} from "../../../../shopping-merchant/tests/support/identity-jwt.js";
import type { MockShoppingCibaProvider } from "../../../../shopping-merchant/tests/support/mock-shopping-ciba-provider.js";
import type { OutboundHandler } from "./harness.js";

/** Route Auth0-pinned host traffic to the in-process CIBA mock and shopping identity JWKS. */
export function createCibaPinnedOutbound(
  mock: MockShoppingCibaProvider,
): OutboundHandler {
  return async (req) => {
    const url = new URL(req.url);
    if (url.hostname !== TEST_DOMAIN) {
      return new Response("upstream_unavailable", { status: 502 });
    }

    if (url.pathname === "/.well-known/jwks.json" && req.method === "GET") {
      const cibaJwks = await mock.fetch(`${mock.issuer}.well-known/jwks.json`, {
        method: "GET",
      });
      const cibaBody = (await cibaJwks.json()) as { keys: unknown[] };
      return Response.json({
        keys: [...cibaBody.keys, SHOPPING_TEST_PUBLIC_JWK],
      });
    }

    if (url.pathname === "/bc-authorize" && req.method === "POST") {
      const body = await req.text();
      return mock.fetch(mock.bcAuthorizeUrl, {
        method: "POST",
        headers: req.headers,
        body,
      });
    }

    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const body = await req.text();
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "authorization_code") {
        if (!params.get("code_verifier")) {
          return Response.json(
            { error: "invalid_grant" },
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        const accessToken = await mintCustomerAccessToken();
        return Response.json({
          access_token: accessToken,
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      return mock.fetch(mock.tokenUrl, {
        method: "POST",
        headers: req.headers,
        body,
      });
    }

    return new Response("not_found", { status: 404 });
  };
}
