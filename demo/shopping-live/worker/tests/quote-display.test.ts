import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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

test("POST /api/quote returns ledger line items, totals, expiry, and destination", async () => {
  const { cookie, csrf } = await harness.login();
  await apiJson(harness.mf, "/api/cart/items", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({ productId: "cup", quantity: 2 }),
  });
  const res = await apiJson<{
    quote?: {
      id: string;
      items: { name?: string; quantity: number; priceMinor?: number }[];
      subtotalMinor: number;
      taxMinor: number;
      shippingMinor: number;
      totalMinor: number;
      currency: string;
      expiresAt: string;
      verified: boolean;
      destination: { id: string; label: string; detailsJson: string };
    };
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
  assert.equal(res.status, 200);
  const quote = res.body.quote!;
  assert.ok(quote.items.length >= 1);
  assert.ok(quote.items[0]!.name);
  assert.equal(quote.items[0]!.quantity, 2);
  assert.equal(quote.verified, true);
  assert.ok(quote.destination.detailsJson.length > 2);
  const read = await apiJson<{ quote?: typeof quote }>(
    harness.mf,
    `/api/quote/${encodeURIComponent(quote.id)}`,
    { cookie },
  );
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.quote?.items, quote.items);
  assert.equal(read.body.quote?.totalMinor, quote.totalMinor);
});
