import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TEST_CUSTOMER } from "../../../shopping-merchant/tests/support/identity-jwt.js";
import {
  ORIGIN,
  apiJson,
  startHarness,
  type Harness,
} from "./support/harness.js";

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.mf.dispose();
});

test("unauthenticated cart returns 401", async () => {
  const { status } = await apiJson(harness.mf, "/api/cart");
  assert.equal(status, 401);
});

test("malformed session cookie returns 401 on cart", async () => {
  const { status } = await apiJson(harness.mf, "/api/cart", {
    cookie: "nsh_sid=not-a-valid-signed-cookie",
  });
  assert.equal(status, 401);
});

test("deferred agent route returns 503", async () => {
  const { status, body } = await apiJson<{ code?: string }>(
    harness.mf,
    "/api/agent/start",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({ goal: "x" }),
    },
  );
  assert.equal(status, 503);
  assert.equal(body.code, "agent_unavailable");
});

test("CSRF blocks cart mutation without token", async () => {
  const { cookie } = await harness.login();
  const { status, body } = await apiJson<{ code?: string }>(
    harness.mf,
    "/api/cart/items",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      cookie,
      body: JSON.stringify({ productId: "tray", quantity: 1 }),
    },
  );
  assert.equal(status, 403);
  assert.equal(body.code, "csrf_required");
});

test("customer isolation rejects cross-customer session reuse", async () => {
  const { cookie, csrf } = await harness.login();
  const { status: cartOk } = await apiJson(harness.mf, "/api/cart/items", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({ productId: "tray", quantity: 1 }),
  });
  assert.equal(cartOk, 200);

  const { status: isolated } = await apiJson(harness.mf, "/api/cart", {
    cookie,
  });
  assert.equal(isolated, 200);
  const { body: cartA } = await apiJson<{ cart?: { items?: unknown[] } }>(
    harness.mf,
    "/api/cart",
    { cookie },
  );
  const other = await harness.login("auth0|other");
  const { body: cartB } = await apiJson<{ cart?: { items?: unknown[] } }>(
    harness.mf,
    "/api/cart",
    { cookie: other.cookie },
  );
  assert.equal((cartA.cart?.items ?? []).length, 1);
  assert.equal(cartB.cart?.items?.length ?? 0, 0);
});

test("forged client prices are replaced by server catalog", async () => {
  const { cookie, csrf } = await harness.login();
  const add = await apiJson<{ cart?: { items?: { priceMinor?: number }[] } }>(
    harness.mf,
    "/api/cart/items",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-nominee-csrf": csrf,
      },
      cookie,
      body: JSON.stringify({ productId: "tray", quantity: 1, priceMinor: 1 }),
    },
  );
  assert.equal(add.status, 200);
  assert.equal(add.body.cart?.items?.[0]?.priceMinor, 2400);
});

test("authenticated session and quote use merchant ledger", async () => {
  const { cookie, csrf } = await harness.login("auth0|quote-customer");
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
  const quote = await apiJson<{ quote?: { verified?: boolean; totalMinor?: number } }>(
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
  assert.equal(quote.body.quote?.verified, true);
  assert.equal(quote.body.quote?.totalMinor, 1800);
});