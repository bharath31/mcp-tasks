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

test("agent capability cookie cannot use customer cart or quote APIs", async () => {
  const { cookie: sessionCookie, csrf } = await harness.login("auth0|cap-a");
  const cap = await harness.mintAgentCap("auth0|cap-a", csrf);
  assert.equal(
    (await apiJson(harness.mf, "/api/cart", { cookie: cap.cookie })).status,
    401,
  );
  assert.equal(
    (
      await apiJson(harness.mf, "/api/quote", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        cookie: cap.cookie,
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (await apiJson(harness.mf, "/api/cart", { cookie: sessionCookie })).status,
    200,
  );
});

test("agent-browser POST requires capability CSRF", async () => {
  const { csrf } = await harness.login("auth0|cap-csrf");
  const cap = await harness.mintAgentCap("auth0|cap-csrf", csrf);
  const { status, body } = await apiJson<{ code?: string }>(
    harness.mf,
    "/api/agent-browser/cart/items",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      cookie: cap.cookie,
      body: JSON.stringify({ productId: "tray", quantity: 1 }),
    },
  );
  assert.equal(status, 403);
  assert.equal(body.code, "csrf_required");
});

test("agent-browser GET allows absent Origin header", async () => {
  const { csrf } = await harness.login("auth0|cap-no-origin");
  const cap = await harness.mintAgentCap("auth0|cap-no-origin", csrf);
  const { status } = await apiJson(harness.mf, "/api/agent-browser/session", {
    cookie: cap.cookie,
  });
  assert.equal(status, 200);
});

test("agent-browser GET rejects foreign Origin when present", async () => {
  const { csrf } = await harness.login("auth0|cap-bad-origin");
  const cap = await harness.mintAgentCap("auth0|cap-bad-origin", csrf);
  const { status } = await apiJson(harness.mf, "/api/agent-browser/cart", {
    cookie: cap.cookie,
    headers: { origin: "https://evil.example" },
  });
  assert.equal(status, 403);
});

test("agent-browser rejects off-origin mutations", async () => {
  const { csrf } = await harness.login("auth0|cap-origin");
  const cap = await harness.mintAgentCap("auth0|cap-origin", csrf);
  const { status } = await apiJson(
    harness.mf,
    "/api/agent-browser/cart/items",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "x-nominee-agent-browser-csrf": cap.csrf,
      },
      cookie: cap.cookie,
      body: JSON.stringify({ productId: "tray", quantity: 1 }),
    },
  );
  assert.equal(status, 403);
});

test("revoked capability fails agent-browser read", async () => {
  const { csrf } = await harness.login("auth0|cap-revoke");
  const cap = await harness.mintAgentCap("auth0|cap-revoke", csrf);
  const add = await apiJson(harness.mf, "/api/agent-browser/cart/items", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-agent-browser-csrf": cap.csrf,
    },
    cookie: cap.cookie,
    body: JSON.stringify({ productId: "tray", quantity: 1 }),
  });
  assert.equal(add.status, 200);
  const alive = await apiJson(harness.mf, "/api/agent-browser/cart", {
    cookie: cap.cookie,
  });
  assert.equal(alive.status, 200);
  await harness.mf.dispatchFetch(`${ORIGIN}/test/revoke-agent-cap`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      customerId: "auth0|cap-revoke",
      runId: cap.runId,
    }),
  });
  const { status } = await apiJson(harness.mf, "/api/agent-browser/cart", {
    cookie: cap.cookie,
  });
  assert.equal(status, 403);
});

test("logout revokes agent-browser access for parent session", async () => {
  const { cookie, csrf } = await harness.login();
  const cap = await harness.mintAgentCap(TEST_CUSTOMER, csrf);
  const active = await apiJson(harness.mf, "/api/agent-browser/session", {
    cookie: cap.cookie,
  });
  assert.equal(active.status, 200);
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
  const { status } = await apiJson(harness.mf, "/api/agent-browser/session", {
    cookie: cap.cookie,
  });
  assert.equal(status, 403);
});

test("cross-customer capability cannot read another customer cart", async () => {
  const a = await harness.login("auth0|cust-a");
  const b = await harness.login("auth0|cust-b");
  const capA = await harness.mintAgentCap("auth0|cust-a", a.csrf);
  await apiJson(harness.mf, "/api/cart/items", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": b.csrf,
    },
    cookie: b.cookie,
    body: JSON.stringify({ productId: "cup", quantity: 1 }),
  });
  const { body: cartB } = await apiJson<{
    cart?: { items?: { productId: string }[] };
  }>(harness.mf, "/api/cart", { cookie: b.cookie });
  assert.ok((cartB.cart?.items ?? []).some((i) => i.productId === "cup"));
  const pre = await apiJson(harness.mf, "/api/agent-browser/cart", {
    cookie: capA.cookie,
    headers: { origin: ORIGIN },
  });
  assert.equal(pre.status, 200);
  const { body: cartA } = await apiJson<{
    cart?: { items?: { productId: string }[] };
  }>(harness.mf, "/api/agent-browser/cart", {
    cookie: capA.cookie,
    headers: { origin: ORIGIN },
  });
  assert.equal((cartA.cart?.items ?? []).length, 0);
});

test("agent run poll requires same parent login session", async () => {
  const first = await harness.login("auth0|poll-a");
  const start = await apiJson<{ id?: string }>(harness.mf, "/api/agent/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": first.csrf,
    },
    cookie: first.cookie,
    body: JSON.stringify({ goal: "Add tray" }),
  });
  assert.equal(start.status, 200);
  assert.ok(start.body.id);
  const second = await harness.login("auth0|poll-a");
  const poll = await apiJson(harness.mf, `/api/agent/${encodeURIComponent(start.body.id!)}`, {
    cookie: second.cookie,
  });
  assert.equal(poll.status, 404);
  const own = await apiJson(harness.mf, `/api/agent/${encodeURIComponent(start.body.id!)}`, {
    cookie: first.cookie,
  });
  assert.equal(own.status, 200);
});
