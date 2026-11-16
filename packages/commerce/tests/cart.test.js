import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCartStore } from "../src/index.js";

const guest = {
  kind: "agent",
  agentId: "a",
  pairwiseUserId: "p",
  sessionId: "s",
  scopes: [],
};
const signed = { ...guest, customerId: "c", scopes: ["cart:write"] };
test("server prices, strict quantities, and durable ownership linking", () => {
  const dir = mkdtempSync(join(tmpdir(), "commerce-"));
  let store = createCartStore(join(dir, "db"));
  try {
    const cart = store.create(guest);
    assert.throws(() => store.read(cart.id, { ...guest, agentId: "other" }));
    assert.throws(() =>
      store.read(cart.id, { kind: "human", customerId: "c", scopes: [] }),
    );
    for (const quantity of [-1, 0, 1.1, "1", Number.MAX_SAFE_INTEGER])
      assert.throws(() =>
        store.update(cart.id, guest, [{ productId: "mug", quantity }]),
      );
    assert.throws(() =>
      store.update(cart.id, guest, [
        { productId: "mug", quantity: 1, priceMinor: 1 },
      ]),
    );
    assert.equal(
      store.update(cart.id, guest, [{ productId: "mug", quantity: 2 }]).items[0]
        .priceMinor,
      1800,
    );
    for (const actor of [
      { ...signed, sessionId: "other" },
      { ...signed, pairwiseUserId: "other" },
      { ...signed, scopes: [] },
    ])
      assert.throws(() => store.link(cart.id, actor));
    const linked = store.link(cart.id, signed);
    assert.deepEqual(store.link(cart.id, signed), linked);
    assert.throws(() =>
      store.link(cart.id, { ...signed, customerId: "other" }),
    );
    assert.throws(() =>
      store.read(cart.id, { ...signed, customerId: "other" }),
    );
    assert.throws(() => store.read(cart.id, { ...signed, scopes: [] }));
    store.close();
    store = createCartStore(join(dir, "db"));
    assert.deepEqual(
      store.read(cart.id, { kind: "human", customerId: "c", scopes: [] }),
      linked,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
