import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createMockShoppingCibaProvider } from "../../../shopping-merchant/tests/support/mock-shopping-ciba-provider.js";
import {
  TEST_CUSTOMER,
  TEST_DOMAIN,
} from "../../../shopping-merchant/tests/support/identity-jwt.js";
import { createCibaPinnedOutbound } from "./support/ciba-outbound.js";
import {
  ORIGIN,
  apiJson,
  startHarness,
  type Harness,
} from "./support/harness.js";
import type { MockShoppingCibaProvider } from "../../../shopping-merchant/tests/support/mock-shopping-ciba-provider.js";

/**
 * Production {@link CustomerMerchantLedger} inside Miniflare with mock Auth0/CIBA outbound only.
 * Does not prove live Guardian display, live tenant Auth0, or real payment push.
 */
let harness: Harness;
let mock: MockShoppingCibaProvider;

const CIBA_BINDINGS = {
  SHOPPING_CIBA_CLIENT_ID: "merchant-ciba-client",
  SHOPPING_CIBA_CLIENT_SECRET: "merchant-ciba-secret",
  SHOPPING_CIBA_BC_AUTHORIZE_URL: `https://${TEST_DOMAIN}/bc-authorize`,
  SHOPPING_CIBA_TOKEN_URL: `https://${TEST_DOMAIN}/oauth/token`,
};

before(async () => {
  mock = await createMockShoppingCibaProvider({ auth0Domain: TEST_DOMAIN });
  harness = await startHarness({
    merchantDo: "production",
    bindings: CIBA_BINDINGS,
    outbound: createCibaPinnedOutbound(mock),
  });
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

function latestAuthReqId(): string {
  const ids = [...mock.requests.keys()];
  assert.ok(ids.length > 0, "no CIBA auth_req_id");
  return ids[ids.length - 1]!;
}

async function pollApproval(
  mf: Harness["mf"],
  cookie: string,
  challengeId: string,
): Promise<{ status: string }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const res = await apiJson<{ status?: string }>(
      mf,
      `/api/approval/${encodeURIComponent(challengeId)}`,
      { cookie },
    );
    if (res.body.status === "approved") {
      return { status: res.body.status };
    }
    if (res.body.status === "failed" || res.body.status === "denied") {
      return { status: res.body.status };
    }
  }
  throw new Error("approval_poll_timeout");
}

test("production DO: cart → quote → CIBA start → poll/bridge with idempotent duplicate poll", async () => {
  const { cookie, csrf } = await harness.login("auth0|ciba-live-1");
  const { quoteId } = await cartQuote(cookie, csrf);

  const started = await apiJson<{ id: string; status: string }>(
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
  assert.equal(started.body.status, "pending");

  mock.decide(latestAuthReqId(), true);
  const approved = await pollApproval(harness.mf, cookie, started.body.id);
  assert.equal(approved.status, "approved");

  const duplicatePoll = await apiJson<{ status?: string }>(
    harness.mf,
    `/api/approval/${encodeURIComponent(started.body.id)}`,
    { cookie },
  );
  assert.equal(duplicatePoll.status, 200);
  assert.equal(duplicatePoll.body.status, "approved");
});

test("production DO: execute flag off stays 503; flag on completes order idempotently", async () => {
  const { cookie, csrf } = await harness.login(TEST_CUSTOMER);
  const { quoteId } = await cartQuote(cookie, csrf);

  const executeOff = await apiJson<{ code?: string }>(
    harness.mf,
    "/api/order/execute",
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
  assert.equal(executeOff.status, 503);

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
  mock.decide(latestAuthReqId(), true);
  await pollApproval(harness.mf, cookie, started.body.id);

  const executeHarness = await startHarness({
    merchantDo: "production",
    bindings: {
      ...CIBA_BINDINGS,
      SHOPPING_GUARDIAN_EXECUTE_ENABLED: "true",
    },
    outbound: createCibaPinnedOutbound(mock),
  });
  try {
    const { cookie: c2, csrf: csrf2 } =
      await executeHarness.login("auth0|execute-live");
    const { quoteId: q2 } = await cartQuoteOn(executeHarness, c2, csrf2);
    const start2 = await apiJson<{ id: string }>(
      executeHarness.mf,
      "/api/approval/start",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-nominee-csrf": csrf2,
        },
        cookie: c2,
        body: JSON.stringify({ quoteId: q2 }),
      },
    );
    mock.decide(latestAuthReqId(), true);
    await pollApproval(executeHarness.mf, c2, start2.body.id);

    const first = await apiJson<{ status?: string; orderId?: string }>(
      executeHarness.mf,
      "/api/order/execute",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-nominee-csrf": csrf2,
        },
        cookie: c2,
        body: JSON.stringify({ quoteId: q2 }),
      },
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "completed");
    assert.ok(first.body.orderId);

    const again = await apiJson<{ status?: string; orderId?: string }>(
      executeHarness.mf,
      "/api/order/execute",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-nominee-csrf": csrf2,
        },
        cookie: c2,
        body: JSON.stringify({ quoteId: q2 }),
      },
    );
    assert.equal(again.status, 200);
    assert.equal(again.body.orderId, first.body.orderId);
  } finally {
    await executeHarness.mf.dispose();
  }
});

async function cartQuoteOn(
  h: Harness,
  cookie: string,
  csrf: string,
): Promise<{ quoteId: string }> {
  await apiJson(h.mf, "/api/cart/items", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({ productId: "cup", quantity: 1 }),
  });
  const quote = await apiJson<{ quote?: { id: string } }>(h.mf, "/api/quote", {
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
  return { quoteId: quote.body.quote!.id };
}

test("execute without approval returns order_approval_required (no raw bypass)", async () => {
  const executeHarness = await startHarness({
    merchantDo: "production",
    bindings: {
      ...CIBA_BINDINGS,
      SHOPPING_GUARDIAN_EXECUTE_ENABLED: "true",
    },
    outbound: createCibaPinnedOutbound(mock),
  });
  try {
    const { cookie, csrf } = await executeHarness.login("auth0|no-approval");
    const { quoteId } = await cartQuoteOn(executeHarness, cookie, csrf);
    const res = await apiJson<{ code?: string }>(
      executeHarness.mf,
      "/api/order/execute",
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
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "order_approval_required");
  } finally {
    await executeHarness.mf.dispose();
  }
});

test("CIBA denial surfaces terminal denied poll (not endless pending)", async () => {
  const { cookie, csrf } = await harness.login("auth0|ciba-denied");
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
  mock.decide(latestAuthReqId(), false);
  const polled = await pollApproval(harness.mf, cookie, started.body.id);
  assert.equal(polled.status, "denied");
});

test("unbridged store-approved resume stays pending; poll bridges without repoll; execute gated", async () => {
  const executeHarness = await startHarness({
    merchantDo: "production",
    bindings: {
      ...CIBA_BINDINGS,
      SHOPPING_GUARDIAN_EXECUTE_ENABLED: "true",
    },
    outbound: createCibaPinnedOutbound(mock),
  });
  try {
    const { cookie, csrf } = await executeHarness.login("auth0|ciba-unbridged");
    const { quoteId } = await cartQuoteOn(executeHarness, cookie, csrf);
    const started = await apiJson<{ id: string; status: string }>(
      executeHarness.mf,
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
    const authReqId = latestAuthReqId();
    mock.decide(authReqId, true);
    const simulate = await apiJson(executeHarness.mf, "/test/ciba-unbridged", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerId: "auth0|ciba-unbridged",
        challengeId: started.body.id,
      }),
    });
    assert.equal(simulate.status, 200);

    const resumed = await apiJson<{
      approval?: { id: string; status: string };
    }>(executeHarness.mf, "/api/checkout/resume", { cookie });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.approval?.id, started.body.id);
    assert.equal(resumed.body.approval?.status, "pending");

    const executeBlocked = await apiJson<{ code?: string }>(
      executeHarness.mf,
      "/api/order/execute",
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
    assert.equal(executeBlocked.status, 409);
    assert.equal(executeBlocked.body.code, "order_approval_required");

    const recovered = await apiJson<{ status?: string }>(
      executeHarness.mf,
      `/api/approval/${encodeURIComponent(started.body.id)}`,
      { cookie },
    );
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.status, "approved");
    assert.ok(mock.requests.has(authReqId), "provider token poll skipped");

    const executeOk = await apiJson<{ status?: string }>(
      executeHarness.mf,
      "/api/order/execute",
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
    assert.equal(executeOk.status, 200);
    assert.equal(executeOk.body.status, "completed");
  } finally {
    await executeHarness.mf.dispose();
  }
});

test("checkout resume rehydrates quote and pending approval after refresh", async () => {
  const { cookie, csrf } = await harness.login("auth0|ciba-resume");
  const { quoteId } = await cartQuote(cookie, csrf);
  const started = await apiJson<{
    id: string;
    status: string;
    delivery?: string;
  }>(harness.mf, "/api/approval/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({ quoteId }),
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.status, "pending");
  assert.equal(started.body.delivery, "guardian_push");

  const resumed = await apiJson<{
    quote?: { id: string; destination: { detailsJson: string } };
    approval?: { id: string; status: string };
  }>(harness.mf, "/api/checkout/resume", { cookie });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.quote?.id, quoteId);
  assert.ok(resumed.body.quote?.destination.detailsJson);
  assert.equal(resumed.body.approval?.id, started.body.id);
  assert.equal(resumed.body.approval?.status, "pending");

  const duplicatePoll = await apiJson<{ status?: string }>(
    harness.mf,
    `/api/approval/${encodeURIComponent(started.body.id)}`,
    { cookie },
  );
  assert.equal(duplicatePoll.status, 200);
  assert.equal(duplicatePoll.body.status, "pending");
});

test("modified cart after quote rejects approval restart (stale quote)", async () => {
  const { cookie, csrf } = await harness.login("auth0|ciba-stale");
  const { quoteId } = await cartQuote(cookie, csrf);
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
  const restart = await apiJson(harness.mf, "/api/approval/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({ quoteId }),
  });
  assert.equal(restart.status, 409);
});
