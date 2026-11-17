import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createMockShoppingCibaProvider } from "../../../shopping-merchant/tests/support/mock-shopping-ciba-provider.js";
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

test("order execute stays fail-closed by default", async () => {
  const { cookie, csrf } = await harness.login();
  const res = await apiJson<{ code?: string }>(harness.mf, "/api/order/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({ quoteId: "quote-any" }),
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "order_execute_unavailable");
});

test("approval start returns unavailable without CIBA env", async () => {
  const { cookie, csrf } = await harness.login();
  const res = await apiJson<{ code?: string }>(harness.mf, "/api/approval/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({ quoteId: "missing" }),
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "approval_unavailable");
});

test("approval route is no longer blanket-deferred", async () => {
  const res = await apiJson(harness.mf, "/api/approval/not-a-challenge");
  assert.notEqual(res.status, 503);
});