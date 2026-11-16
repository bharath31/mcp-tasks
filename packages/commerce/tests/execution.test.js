import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("a changed trusted destination remains human-gated on every revision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "destination-"));
  const { auth, options } = setup();
  const addresses = ["A", "B"].map((id) => ({
    id,
    customerId: agent.customerId,
    label: id,
    version: "1",
    trustedForAgentCheckout: true,
    destination: { country: "US", city: id },
  }));
  options.customerAccount = {
    async getAddress(customerId, id) {
      return (
        addresses.find((a) => a.customerId === customerId && a.id === id) ??
        null
      );
    },
  };
  let calls = 0;
  const provider = options.orderProvider;
  options.orderProvider = {
    ...provider,
    async place(input) {
      calls++;
      return provider.place(input);
    },
  };
  let store = createCartStore(join(dir, "db"), options);
  try {
    const cart = store.create(agent);
    store.update(cart.id, agent, [{ productId: "tea", quantity: 1 }]);
    const first = await store.createQuote(cart.id, agent, "A");
    assert.equal(first.requirement, "agent_confirmation");
    const second = await store.createQuote(cart.id, agent, "B");
    assert.equal(second.requirement, "customer_verification");
    auth.reviewForTest(second);
    await store.recordHumanReview(second.id, human);
    store.close();
    store = createCartStore(join(dir, "db"), options);
    const third = await store.createQuote(cart.id, agent, "B");
    assert.equal(third.operationId, first.operationId);
    assert.equal(third.destinationVerificationRequired, true);
    assert.equal(third.requirement, "customer_verification");
    auth.confirmForTest(third);
    assert.equal(
      (await store.completeQuote(third.id, agent)).status,
      "customer_verification_required",
    );
    assert.equal(calls, 0);
    auth.reviewForTest(third);
    await store.recordHumanReview(third.id, human);
    assert.equal(
      (await store.completeQuote(third.id, agent)).status,
      "completed",
    );
    assert.equal(calls, 1);
    const next = await store.createQuote(cart.id, agent, "A");
    assert.notEqual(next.operationId, third.operationId);
    assert.equal(next.requirement, "agent_confirmation");
    await store.createQuote(cart.id, agent, "B");
    const returned = await store.createQuote(cart.id, agent, "A");
    assert.equal(returned.requirement, "customer_verification");
    auth.confirmForTest(returned);
    assert.equal(
      (await store.completeQuote(returned.id, agent)).status,
      "customer_verification_required",
    );
    assert.equal(calls, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy quote history retains changed-destination escalation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-destination-"));
  const path = join(dir, "db");
  const { options } = setup();
  options.customerAccount = {
    async getAddress(customerId, id) {
      return {
        id,
        customerId,
        label: id,
        version: "1",
        trustedForAgentCheckout: true,
        destination: { id },
      };
    },
  };
  let store = createCartStore(path, options);
  try {
    const cart = store.create(agent);
    store.update(cart.id, agent, [{ productId: "tea", quantity: 1 }]);
    await store.createQuote(cart.id, agent, "A");
    await store.createQuote(cart.id, agent, "B");
    store.close();
    const db = new DatabaseSync(path);
    try {
      for (const row of db.prepare("SELECT id, data FROM quotes").all()) {
        const quote = JSON.parse(row.data);
        delete quote.destinationVerificationRequired;
        db.prepare("UPDATE quotes SET data = ? WHERE id = ?").run(
          JSON.stringify(quote),
          row.id,
        );
      }
    } finally {
      db.close();
    }
    store = createCartStore(path, options);
    const third = await store.createQuote(cart.id, agent, "B");
    assert.equal(third.destinationVerificationRequired, true);
    assert.equal(third.requirement, "customer_verification");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an already-issued legacy A-B-B quote cannot execute before safe requote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-direct-"));
  const path = join(dir, "db");
  const { auth, options } = setup();
  const counts = {
    account: 0,
    policy: 0,
    confirmation: 0,
    human: 0,
    place: 0,
    reconcile: 0,
  };
  options.customerAccount = {
    async getAddress(customerId, id) {
      counts.account++;
      return {
        id,
        customerId,
        label: id,
        version: "1",
        trustedForAgentCheckout: true,
        destination: { id },
      };
    },
  };
  const evaluate = options.authorization.evaluate;
  options.authorization = {
    async evaluate(input) {
      counts.policy++;
      return evaluate(input);
    },
  };
  const confirm = options.verifyAgentConfirmation;
  options.verifyAgentConfirmation = async (input) => {
    counts.confirmation++;
    return confirm(input);
  };
  const verify = options.verifyHumanReview;
  options.verifyHumanReview = async (input) => {
    counts.human++;
    return verify(input);
  };
  const provider = options.orderProvider;
  options.orderProvider = {
    async place(input) {
      counts.place++;
      return provider.place(input);
    },
    async reconcile(input) {
      counts.reconcile++;
      return provider.reconcile(input);
    },
  };
  let store = createCartStore(path, options);
  try {
    const cart = store.create(agent);
    store.update(cart.id, agent, [{ productId: "tea", quantity: 1 }]);
    await store.createQuote(cart.id, agent, "A");
    await store.createQuote(cart.id, agent, "B");
    const legacy = await store.createQuote(cart.id, agent, "B");
    store.close();
    const db = new DatabaseSync(path);
    try {
      for (const row of db.prepare("SELECT id, data FROM quotes").all()) {
        const quote = JSON.parse(row.data);
        delete quote.destinationVerificationRequired;
        if (row.id === legacy.id) quote.requirement = "agent_confirmation";
        db.prepare("UPDATE quotes SET data = ? WHERE id = ?").run(
          JSON.stringify(quote),
          row.id,
        );
      }
    } finally {
      db.close();
    }
    store = createCartStore(path, options);
    auth.confirmForTest(legacy);
    for (const key of Object.keys(counts)) counts[key] = 0;
    assert.equal(store.getQuote(legacy.id, agent).id, legacy.id);
    assert.equal(store.getHumanReview(legacy.id, human), null);
    await assert.rejects(
      store.completeQuote(legacy.id, agent),
      /legacy_quote_requires_requote/,
    );
    await assert.rejects(
      store.recordHumanReview(legacy.id, human),
      /legacy_quote_requires_requote/,
    );
    await assert.rejects(
      store.reconcileQuote(legacy.id, agent),
      /legacy_quote_requires_requote/,
    );
    assert.deepEqual(counts, {
      account: 0,
      policy: 0,
      confirmation: 0,
      human: 0,
      place: 0,
      reconcile: 0,
    });
    const fresh = await store.createQuote(cart.id, agent, "B");
    assert.equal(fresh.operationId, legacy.operationId);
    assert.equal(fresh.destinationVerificationRequired, true);
    assert.equal(fresh.requirement, "customer_verification");
    auth.confirmForTest(fresh);
    assert.equal(
      (await store.completeQuote(fresh.id, agent)).status,
      "customer_verification_required",
    );
    assert.equal(counts.place, 0);
    auth.reviewForTest(fresh);
    await store.recordHumanReview(fresh.id, human);
    assert.equal(
      (await store.completeQuote(fresh.id, agent)).status,
      "completed",
    );
    assert.equal(counts.place, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepted timeout reconciles after expiry and completed replay ignores later revisions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-expired-"));
  let calls = 0,
    accepted;
  const provider = {
    async place() {
      calls++;
      accepted = { id: "provider-accepted" };
      throw Error("timeout");
    },
    async reconcile() {
      return accepted;
    },
  };
  const { auth, options } = setup(provider);
  let store = createCartStore(join(dir, "db"), options);
  const realNow = Date.now;
  try {
    const cart = store.create(agent);
    store.update(cart.id, agent, [{ productId: "tea", quantity: 1 }]);
    const quote = await store.createQuote(cart.id, agent, "fixture-home");
    auth.confirmForTest(quote);
    assert.equal(
      (await store.completeQuote(quote.id, agent)).status,
      "processing",
    );
    store.close();
    const originalAccount = options.customerAccount;
    options.customerAccount = {
      async getAddress() {
        return null;
      },
    };
    store = createCartStore(join(dir, "db"), options);
    Date.now = () => realNow() + 3600000;
    await assert.rejects(
      store.reconcileQuote(quote.id, { ...agent, agentId: "other" }),
    );
    await assert.rejects(
      store.reconcileQuote(quote.id, { ...agent, scopes: [] }),
    );
    await assert.rejects(
      store.reconcileQuote(quote.id, { ...agent, customerId: "other" }),
    );
    await assert.rejects(store.reconcileQuote(quote.id, human));
    const completed = await store.reconcileQuote(quote.id, agent);
    assert.equal(completed.status, "completed");
    assert.deepEqual(await store.completeQuote(quote.id, agent), completed);
    Date.now = realNow;
    options.customerAccount = originalAccount;
    store.update(cart.id, agent, [{ productId: "tea", quantity: 2 }]);
    const next = await store.createQuote(cart.id, agent, "fixture-home");
    assert.notEqual(next.operationId, quote.operationId);
    assert.deepEqual(await store.completeQuote(quote.id, agent), completed);
    await assert.rejects(
      store.completeQuote(quote.id, { ...agent, pairwiseUserId: "other" }),
    );
    assert.equal(calls, 1);
  } finally {
    Date.now = realNow;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown provider outcome cannot be abandoned without an atomic fence", async () => {
  const provider = {
    async place() {
      throw Error("unknown");
    },
    async reconcile() {
      return null;
    },
  };
  const { auth, options } = setup(provider);
  const store = createCartStore(":memory:", options);
  try {
    const cart = store.create(agent);
    store.update(cart.id, agent, [{ productId: "mug", quantity: 1 }]);
    const quote = await store.createQuote(cart.id, agent, "fixture-home");
    auth.confirmForTest(quote);
    assert.equal(
      (await store.completeQuote(quote.id, agent)).status,
      "processing",
    );
    assert.equal(
      (await store.reconcileQuote(quote.id, agent)).status,
      "processing",
    );
    await assert.rejects(
      store.abandonQuote(quote.id, agent),
      /safe_abandon_unavailable/,
    );
    assert.throws(
      () => store.update(cart.id, agent, []),
      /checkout_processing/,
    );
  } finally {
    store.close();
  }
});
