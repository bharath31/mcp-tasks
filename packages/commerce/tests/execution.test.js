import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCartStore,
  createFixtureCustomerAccountPort,
  createFixtureAuthorization,
  createFixtureOrderProvider,
} from "../src/index.js";
const agent = {
  kind: "agent",
  customerId: "fixture-customer",
  agentId: "a",
  pairwiseUserId: "u",
  sessionId: "s",
  scopes: ["cart:write", "checkout:write", "addresses:read"],
};
const human = { kind: "human", customerId: "fixture-customer", scopes: [] };
function setup(provider) {
  const auth = createFixtureAuthorization("fixture");
  const options = {
    customerAccount: createFixtureCustomerAccountPort(),
    ...auth,
    orderProvider: provider ?? createFixtureOrderProvider("fixture"),
  };
  return { auth, options };
}
test("fixture purchase requires confirmation, claims once, replays and starts a new purchase", async () => {
  const { auth, options } = setup();
  let calls = 0;
  const provider = options.orderProvider;
  options.orderProvider = {
    ...provider,
    async place(input) {
      calls++;
      return provider.place(input);
    },
  };
  const store = createCartStore(":memory:", options);
  try {
    const cart = store.create(agent);
    store.update(cart.id, agent, [{ productId: "mug", quantity: 1 }]);
    const quote = await store.createQuote(cart.id, agent, "fixture-home");
    assert.deepEqual(await store.completeQuote(quote.id, agent), {
      status: "approval_required",
    });
    assert.equal(calls, 0);
    await assert.rejects(
      store.completeQuote(quote.id, { ...agent, agentId: "wrong" }),
    );
    await assert.rejects(
      store.completeQuote(quote.id, { ...agent, scopes: [] }),
    );
    auth.confirmForTest(quote);
    const results = await Promise.all([
      store.completeQuote(quote.id, agent),
      store.completeQuote(quote.id, agent),
    ]);
    assert.equal(calls, 1);
    const complete = results.find((r) => r.status === "completed");
    assert.ok(complete);
    assert.deepEqual(await store.completeQuote(quote.id, agent), complete);
    const next = await store.createQuote(cart.id, agent, "fixture-home");
    assert.notEqual(next.operationId, quote.operationId);
    assert.equal(
      (await store.completeQuote(next.id, agent)).status,
      "approval_required",
    );
  } finally {
    store.close();
  }
});
test("high risk requires exact human review; spoofed actor assertions do not authorize", async () => {
  const { auth, options } = setup();
  let calls = 0;
  const provider = options.orderProvider;
  options.orderProvider = {
    ...provider,
    async place(input) {
      calls++;
      return provider.place(input);
    },
  };
  const store = createCartStore(":memory:", options);
  try {
    const cart = store.create(agent);
    store.update(cart.id, agent, [{ productId: "mug", quantity: 4 }]);
    const quote = await store.createQuote(cart.id, agent, "fixture-home");
    auth.confirmForTest(quote);
    assert.equal(
      (
        await store.completeQuote(quote.id, {
          ...agent,
          approver: "user",
          human: true,
        })
      ).status,
      "customer_verification_required",
    );
    await assert.rejects(store.recordHumanReview(quote.id, agent));
    await assert.rejects(
      store.recordHumanReview(quote.id, { ...human, approved: true }),
      /human_review_unverified/,
    );
    assert.equal(calls, 0);
    auth.reviewForTest(quote);
    await store.recordHumanReview(quote.id, human);
    assert.equal(
      (await store.completeQuote(quote.id, agent)).status,
      "completed",
    );
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});
test("timeout persists processing across restart, reconciliation never places again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "checkout-"));
  let placed = 0,
    found = null;
  const provider = {
    async place({ idempotencyKey }) {
      placed++;
      found = { id: `order-${idempotencyKey}` };
      throw new Error("timeout");
    },
    async reconcile() {
      return found;
    },
  };
  const { auth, options } = setup(provider);
  let store = createCartStore(join(dir, "db"), options);
  try {
    const cart = store.create(agent);
    store.update(cart.id, agent, [{ productId: "tea", quantity: 1 }]);
    const quote = await store.createQuote(cart.id, agent, "fixture-home");
    auth.confirmForTest(quote);
    assert.equal(
      (await store.completeQuote(quote.id, agent)).status,
      "processing",
    );
    assert.equal(
      (await store.completeQuote(quote.id, agent)).status,
      "processing",
    );
    await assert.rejects(
      store.createQuote(cart.id, agent, "fixture-home"),
      /checkout_processing/,
    );
    store.close();
    store = createCartStore(join(dir, "db"), options);
    assert.equal(
      (await store.reconcileQuote(quote.id, agent)).status,
      "completed",
    );
    assert.equal(
      (await store.completeQuote(quote.id, agent)).status,
      "completed",
    );
    assert.equal(placed, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("missing or denying policy refuses dispatch", async () => {
  const { auth, options } = setup();
  options.authorization = {
    async evaluate() {
      return "denied";
    },
  };
  const store = createCartStore(":memory:", options);
  try {
    const cart = store.create(agent);
    store.update(cart.id, agent, [{ productId: "tea", quantity: 1 }]);
    const quote = await store.createQuote(cart.id, agent, "fixture-home");
    auth.confirmForTest(quote);
    assert.deepEqual(await store.completeQuote(quote.id, agent), {
      status: "denied",
    });
  } finally {
    store.close();
  }
  const missing = createCartStore(":memory:");
  try {
    await assert.rejects(
      missing.completeQuote("x", agent),
      /checkout_adapters_unavailable/,
    );
  } finally {
    missing.close();
  }
});

test("in-flight claim blocks a racing caller and cart mutation", async () => {
  let release, started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const provider = {
    async place() {
      calls++;
      started();
      await hold;
      return { id: "fixture-order" };
    },
    async reconcile() {
      return null;
    },
  };
  const { auth, options } = setup(provider);
  const store = createCartStore(":memory:", options);
  try {
    const cart = store.create(agent);
    store.update(cart.id, agent, [{ productId: "tea", quantity: 1 }]);
    const quote = await store.createQuote(cart.id, agent, "fixture-home");
    auth.confirmForTest(quote);
    await assert.rejects(store.completeQuote(quote.id, human));
    const first = store.completeQuote(quote.id, agent);
    await entered;
    assert.deepEqual(await store.completeQuote(quote.id, agent), {
      status: "processing",
    });
    assert.deepEqual(await store.reconcileQuote(quote.id, agent), {
      status: "processing",
    });
    assert.throws(
      () => store.update(cart.id, agent, [{ productId: "tea", quantity: 2 }]),
      /checkout_processing/,
    );
    release();
    assert.equal((await first).status, "completed");
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});
