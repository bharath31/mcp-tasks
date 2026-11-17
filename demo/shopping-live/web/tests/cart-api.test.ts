import assert from "node:assert/strict";
import test from "node:test";
import { shoppingApi } from "../src/api.js";

const originalFetch = globalThis.fetch;

test("addCartItem POSTs productId and quantity to /api/cart/items", async (t) => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seenUrl = String(input);
    seenInit = init;
    return new Response(
      JSON.stringify({
        cart: { id: "c1", items: [{ productId: "tray", quantity: 1 }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await shoppingApi.addCartItem("tray", 1);
  assert.equal(result.ok, true);
  assert.equal(seenUrl, "/api/cart/items");
  assert.equal(seenInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(seenInit?.body)), {
    productId: "tray",
    quantity: 1,
  });
});

test("addCartItem surfaces API errors without inventing cart state", async (t) => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ code: "cart_failed", message: "Cart update rejected." }),
      { status: 422, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await shoppingApi.addCartItem("tray", 1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.message, "Cart update rejected.");
    assert.equal(result.error.status, 422);
  }
});
