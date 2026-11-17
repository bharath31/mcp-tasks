import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createMockShoppingCibaProvider } from "../../../shopping-merchant/tests/support/mock-shopping-ciba-provider.js";
import { TEST_DOMAIN } from "../../../shopping-merchant/tests/support/identity-jwt.js";
import { createCibaPinnedOutbound } from "./support/ciba-outbound.js";
import {
  ORIGIN,
  apiJson,
  startHarness,
  type Harness,
} from "./support/harness.js";
import type { MockShoppingCibaProvider } from "../../../shopping-merchant/tests/support/mock-shopping-ciba-provider.js";

let harness: Harness;
let mock: MockShoppingCibaProvider;

const CIBA_BINDINGS = {
  SHOPPING_CIBA_CLIENT_ID: "merchant-ciba-client",
  SHOPPING_CIBA_CLIENT_SECRET: "merchant-ciba-secret",
  SHOPPING_CIBA_BC_AUTHORIZE_URL: `https://${TEST_DOMAIN}/bc-authorize`,
  SHOPPING_CIBA_TOKEN_URL: `https://${TEST_DOMAIN}/oauth/token`,
};

let cibaTokenPolls = 0;

before(async () => {
  mock = await createMockShoppingCibaProvider({ auth0Domain: TEST_DOMAIN });
  const baseOutbound = createCibaPinnedOutbound(mock);
  harness = await startHarness({
    merchantDo: "production",
    bindings: CIBA_BINDINGS,
    outbound: async (req, mf) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const body = await req.clone().text();
        if (
          new URLSearchParams(body).get("grant_type") ===
          "urn:openid:params:grant-type:ciba"
        ) {
          cibaTokenPolls += 1;
        }
      }
      return baseOutbound(req, mf);
    },
  });
});

beforeEach(() => {
  cibaTokenPolls = 0;
});

after(async () => {
  await harness.mf.dispose();
});

async function cartQuote(
  cookie: string,
  csrf: string,
): Promise<{ quoteId: string }> {
  await apiJson(harness.mf, "/api/cart/items", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({ productId: "cup", quantity: 1 }),
  });
  const quote = await apiJson<{ quote?: { id: string } }>(
    harness.mf,
    "/api/quote",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-nominee-csrf": csrf,
      },
      cookie,
      body: JSON.stringify({}),
    },
  );
  assert.equal(quote.status, 200);
  assert.ok(quote.body.quote?.id);
  return { quoteId: quote.body.quote!.id };
}

test("expired quote read returns 404 and resume clears checkout pointers", async () => {
  const { cookie, csrf } = await harness.login("auth0|quote-expired");
  const { quoteId } = await cartQuote(cookie, csrf);
  const started = await apiJson<{ id: string }>(
    harness.mf,
    "/api/approval/start",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-nominee-csrf": csrf,
      },
      cookie,
      body: JSON.stringify({ quoteId }),
    },
  );
  assert.equal(started.status, 200);

  const expire = await apiJson(harness.mf, "/test/expire-quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId: "auth0|quote-expired",
      quoteId,
      expiresAt: "2000-01-01T00:00:00.000Z",
    }),
  });
  assert.equal(expire.status, 200);

  const read = await apiJson(harness.mf, `/api/quote/${encodeURIComponent(quoteId)}`, {
    cookie,
  });
  assert.equal(read.status, 404);

  const resumed = await apiJson<{
    quote?: unknown;
    approval?: unknown;
  }>(harness.mf, "/api/checkout/resume", { cookie });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.quote ?? null, null);
  assert.equal(resumed.body.approval ?? null, null);

  const resumedAgain = await apiJson<{
    quote?: unknown;
    approval?: unknown;
  }>(harness.mf, "/api/checkout/resume", { cookie });
  assert.equal(resumedAgain.status, 200);
  assert.equal(resumedAgain.body.quote ?? null, null);
  assert.equal(resumedAgain.body.approval ?? null, null);
});

test("stale cart quote is omitted on resume (not verified)", async () => {
  const { cookie, csrf } = await harness.login("auth0|quote-stale-resume");
  const { quoteId } = await cartQuote(cookie, csrf);
  const started = await apiJson<{ id: string }>(
    harness.mf,
    "/api/approval/start",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-nominee-csrf": csrf,
      },
      cookie,
      body: JSON.stringify({ quoteId }),
    },
  );
  assert.equal(started.status, 200);

  await apiJson(harness.mf, "/api/cart/items", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({ productId: "tray", quantity: 1 }),
  });

  const resumed = await apiJson<{
    quote?: { verified?: boolean };
    approval?: unknown;
  }>(harness.mf, "/api/checkout/resume", { cookie });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.quote ?? null, null);
  assert.equal(resumed.body.approval ?? null, null);
});

test("checkout resume does not advance CIBA provider polling", async () => {
  const { cookie, csrf } = await harness.login("auth0|resume-no-poll");
  const { quoteId } = await cartQuote(cookie, csrf);
  const started = await apiJson<{ id: string }>(
    harness.mf,
    "/api/approval/start",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-nominee-csrf": csrf,
      },
      cookie,
      body: JSON.stringify({ quoteId }),
    },
  );
  assert.equal(started.status, 200);
  const pollsBefore = cibaTokenPolls;

  const resumed = await apiJson(harness.mf, "/api/checkout/resume", { cookie });
  assert.equal(resumed.status, 200);
  assert.equal(cibaTokenPolls, pollsBefore);
});