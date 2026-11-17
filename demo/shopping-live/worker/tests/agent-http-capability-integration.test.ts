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
  harness = await startHarness({
    workerEntry: "test-worker-http-capability-entry.ts",
    selfSubfetch: true,
  });
});

after(async () => {
  await harness.mf.dispose();
});

// Browser UI / Puppeteer not exercised; capability cookie → agent-browser HTTP → ledger.
test("agent start with HTTP capability ports updates customer cart", async () => {
  const { cookie, csrf } = await harness.login(TEST_CUSTOMER);
  const start = await apiJson<{ id?: string }>(harness.mf, "/api/agent/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({ goal: "Add a catchall tray to my cart" }),
  });
  assert.equal(start.status, 200);
  assert.ok(start.body.id);
  const cart = await apiJson<{ cart?: { items?: { productId: string }[] } }>(
    harness.mf,
    "/api/cart",
    { cookie },
  );
  assert.ok((cart.body.cart?.items ?? []).some((i) => i.productId === "tray"));
});