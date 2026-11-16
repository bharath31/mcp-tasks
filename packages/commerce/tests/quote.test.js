import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createCartStore,
  createFixtureCustomerAccountPort,
} from "../src/index.js";

const actor = {
  kind: "agent",
  customerId: "c",
  agentId: "a",
  pairwiseUserId: "p",
  sessionId: "s",
  scopes: ["cart:write", "checkout:write", "addresses:read"],
};
test("immutable revisions, ownership, scope, address and cart revalidation survive reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quotes-"));
  let address = {
    id: "home",
    customerId: "c",
    label: "Home",
    version: "1",
    trustedForAgentCheckout: true,
    destination: { postalCode: "12345" },
  };
  let reads = 0;
  const options = {
    customerAccount: {
      getAddress: async () => {
        reads++;
        return address;
      },
    },
  };
  let store = createCartStore(join(dir, "db"), options);
  try {
    const cart = store.create(actor);
    store.update(cart.id, actor, [{ productId: "mug", quantity: 2 }]);
    await assert.rejects(
      store.createQuote(
        cart.id,
        { ...actor, scopes: ["cart:write", "checkout:write"] },
        "home",
      ),
    );
    assert.equal(reads, 0);
    await assert.rejects(
      store.createQuote(cart.id, { ...actor, customerId: "other" }, "home"),
    );
    const first = await store.createQuote(cart.id, actor, "home");
    assert.equal(first.totalMinor, 3600);
    assert.equal(first.requirement, "agent_confirmation");
    first.items[0].priceMinor = 1;
    first.destination.destination.postalCode = "evil";
    assert.equal(store.getQuote(first.id, actor).items[0].priceMinor, 1800);
    assert.equal(
      (await store.validateQuote(first.id, actor)).destination.destination
        .postalCode,
      "12345",
    );
    assert.throws(() =>
      store.getQuote(first.id, { ...actor, agentId: "other" }),
    );
    assert.throws(() =>
      store.getQuote(first.id, { ...actor, customerId: "other" }),
    );
    const second = await store.createQuote(cart.id, actor, "home");
    assert.equal(second.operationId, first.operationId);
    assert.equal(second.revision, first.revision + 1);
    await assert.rejects(store.validateQuote(first.id, actor), /stale_quote/);
    store.close();
    store = createCartStore(join(dir, "db"), options);
    assert.deepEqual(await store.validateQuote(second.id, actor), second);
    address = { ...address, version: "2" };
    await assert.rejects(store.validateQuote(second.id, actor), /stale_quote/);
    address = { ...address, version: "1", customerId: "other" };
    await assert.rejects(store.validateQuote(second.id, actor));
    address = { ...address, customerId: "c" };
    store.update(cart.id, actor, [{ productId: "tea", quantity: 1 }]);
    await assert.rejects(store.validateQuote(second.id, actor), /stale_quote/);
    const third = await store.createQuote(cart.id, actor, "home");
    const now = Date.now;
    try {
      Date.now = () => Date.parse(third.expiresAt);
      await assert.rejects(store.validateQuote(third.id, actor), /stale_quote/);
    } finally {
      Date.now = now;
    }
    await assert.rejects(
      store.createQuote(cart.id, actor, { id: "home", price: 1 }),
      /invalid_address/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guest and absent account adapters fail closed", async () => {
  const store = createCartStore(":memory:");
  try {
    const guest = {
      kind: "agent",
      agentId: "a",
      pairwiseUserId: "p",
      sessionId: "s",
      scopes: [],
    };
    const cart = store.create(guest);
    await assert.rejects(store.createQuote(cart.id, guest, "home"));
    const accountCart = store.create(actor);
    await assert.rejects(
      store.createQuote(accountCart.id, actor, "home"),
      /customer_account_unavailable/,
    );
  } finally {
    store.close();
  }
});

test("tampered stored cart price is refused and fixture addresses are customer-bound", async () => {
  const fixture = createFixtureCustomerAccountPort();
  assert.equal((await fixture.listAddresses("fixture-customer")).length, 2);
  assert.equal(await fixture.getAddress("other", "fixture-home"), null);
  const dir = mkdtempSync(join(tmpdir(), "price-"));
  const path = join(dir, "db");
  const store = createCartStore(path, { customerAccount: fixture });
  const who = { kind: "human", customerId: "fixture-customer", scopes: [] };
  try {
    const cart = store.create(who);
    store.update(cart.id, who, [{ productId: "mug", quantity: 1 }]);
    const quote = await store.createQuote(cart.id, who, "fixture-home");
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE carts SET items = ? WHERE id = ?").run(
        JSON.stringify([
          { productId: "mug", quantity: 1, priceMinor: 1, currency: "USD" },
        ]),
        cart.id,
      );
    } finally {
      db.close();
    }
    await assert.rejects(
      store.validateQuote(quote.id, who),
      /stale_cart_price/,
    );
    await assert.rejects(
      store.createQuote(cart.id, who, "fixture-home"),
      /stale_cart_price/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
