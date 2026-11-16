import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCartStore,
  createFixtureCustomerAccountPort,
} from "../src/index.js";

const human = { kind: "human", customerId: "fixture-customer", scopes: [] };
const agent = {
  kind: "agent",
  customerId: "fixture-customer",
  agentId: "a",
  pairwiseUserId: "p",
  sessionId: "s",
  scopes: ["cart:write", "checkout:write", "addresses:read"],
};

test("only injected operation-bound human verification can record a durable non-executable review", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-"));
  const path = join(dir, "db");
  let expected = null;
  const options = {
    customerAccount: createFixtureCustomerAccountPort(),
    verifyHumanReview: async ({ actor, quote }) =>
      actor.customerId === human.customerId &&
      expected === `${quote.operationId}:${quote.revision}`,
  };
  let store = createCartStore(path, options);
  try {
    const cart = store.create(agent);
    store.update(cart.id, agent, [{ productId: "mug", quantity: 1 }]);
    const quote = await store.createQuote(cart.id, agent, "fixture-home");
    await assert.rejects(store.recordHumanReview(quote.id, agent));
    await assert.rejects(
      store.recordHumanReview(quote.id, { ...human, customerId: "other" }),
    );
    await assert.rejects(
      store.recordHumanReview(quote.id, {
        ...human,
        approver: "user",
        approved: true,
      }),
      /human_review_unverified/,
    );
    expected = `${quote.operationId}:${quote.revision}`;
    const result = await store.recordHumanReview(quote.id, human);
    assert.equal(result.revision, quote.revision);
    assert.deepEqual(await store.recordHumanReview(quote.id, human), result);
    assert.throws(() => store.getHumanReview(quote.id, agent));
    store.close();
    store = createCartStore(path, options);
    assert.deepEqual(store.getHumanReview(quote.id, human), result);
    const next = await store.createQuote(cart.id, agent, "fixture-home");
    assert.equal(store.getHumanReview(next.id, human), null);
    await assert.rejects(
      store.recordHumanReview(next.id, human),
      /human_review_unverified/,
    );
    await assert.rejects(
      store.recordHumanReview(quote.id, human),
      /stale_quote/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing verifier fails closed and changed cart during proof is rejected", async () => {
  const account = createFixtureCustomerAccountPort();
  let release;
  let started;
  const called = new Promise((resolve) => {
    started = resolve;
  });
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const store = createCartStore(":memory:", {
    customerAccount: account,
    verifyHumanReview: async () => {
      started();
      await hold;
      return true;
    },
  });
  try {
    const cart = store.create(human);
    store.update(cart.id, human, [{ productId: "tea", quantity: 1 }]);
    const quote = await store.createQuote(cart.id, human, "fixture-home");
    const pending = store.recordHumanReview(quote.id, human);
    await called;
    store.update(cart.id, human, [{ productId: "tea", quantity: 2 }]);
    release();
    await assert.rejects(pending, /stale_quote/);
    assert.equal(store.getHumanReview(quote.id, human), null);
  } finally {
    store.close();
  }
  const noVerifier = createCartStore(":memory:", { customerAccount: account });
  try {
    await assert.rejects(
      noVerifier.recordHumanReview("anything", human),
      /human_review_unavailable/,
    );
  } finally {
    noVerifier.close();
  }
});
