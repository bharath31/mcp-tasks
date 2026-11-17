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

test("agent start requires authenticated customer session", async () => {
  const { status, body } = await apiJson<{ code?: string }>(
    harness.mf,
    "/api/agent/start",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({ goal: "Add a tray to my cart" }),
    },
  );
  assert.equal(status, 401);
  assert.equal(body.code, "unauthorized");
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

test("GET logout does not revoke session", async () => {
  const { cookie } = await harness.login();
  const logout = await harness.mf.dispatchFetch(`${ORIGIN}/auth/logout`, {
    headers: { cookie },
  });
  assert.equal(logout.status, 405);
  const { status } = await apiJson(harness.mf, "/api/cart", { cookie });
  assert.equal(status, 200);
});

test("POST logout requires CSRF", async () => {
  const { cookie } = await harness.login();
  const res = await harness.mf.dispatchFetch(`${ORIGIN}/auth/logout`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      cookie,
    },
    body: "{}",
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { code?: string };
  assert.equal(body.code, "csrf_required");
});

test("POST logout revokes session with CSRF", async () => {
  const { cookie, csrf } = await harness.login();
  const logout = await harness.mf.dispatchFetch(`${ORIGIN}/auth/logout`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-nominee-csrf": csrf,
      cookie,
    },
    body: "{}",
  });
  assert.equal(logout.status, 303);
  const { status } = await apiJson(harness.mf, "/api/cart", { cookie });
  assert.equal(status, 401);
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
  const quote = await apiJson<{
    quote?: { verified?: boolean; totalMinor?: number };
  }>(harness.mf, "/api/quote", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({}),
  });
  assert.equal(quote.status, 200);
  assert.equal(quote.body.quote?.verified, true);
  assert.equal(quote.body.quote?.totalMinor, 1800);
});
