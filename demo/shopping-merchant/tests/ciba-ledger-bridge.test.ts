import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AGENT_SESSION_SCOPES } from "../src/identity/index.js";
import { buildGuardianPurchaseAuthorizationDetails } from "../src/approval/guardian-transaction-details.js";
import { canonicalAuthorizationDetailsJson } from "../src/ciba/canonical.js";
import { recordApprovalWithConsumedChallenge } from "../src/ciba/ledger-bridge.js";
import { initCibaChallengeSchema } from "../src/ciba/schema.js";
import { createMerchantLedger, ORDER_EXECUTE_SCOPE } from "../src/ledger.js";
import { createNodeSqlDatabase, initMerchantSchema } from "../src/sql.js";
import type { AgentActor, HumanActor, Quote } from "../src/types.js";
import {
  createFixtureCustomerAccount,
  createFixtureOrderProvider,
} from "./support/fixtures.js";
import type { PurchaseCibaChallenge } from "../src/ciba/challenge-types.js";
import { createSqlCibaChallengeStore } from "../src/ciba/sql-ciba-challenge-store.js";

const CUSTOMER = "fixture-customer";
const MERCHANT = "Nominee Fixture Shop";
const agent: AgentActor = {
  kind: "agent",
  customerId: CUSTOMER,
  agentId: "agent-a",
  pairwiseUserId: "user-u",
  sessionId: "session-s",
  scopes: [
    "cart:write",
    "checkout:write",
    "addresses:read",
    ORDER_EXECUTE_SCOPE,
  ],
};
const human: HumanActor = { kind: "human", customerId: CUSTOMER, scopes: [] };

function openDb() {
  const raw = new DatabaseSync(":memory:");
  const db = createNodeSqlDatabase(raw);
  initMerchantSchema(db);
  initCibaChallengeSchema(db);
  return { raw, db };
}

function ledgerWithoutVerifier(db: ReturnType<typeof createNodeSqlDatabase>) {
  return createMerchantLedger(
    db,
    {
      customerAccount: createFixtureCustomerAccount(),
      verifyCustomerApproval: async () => false,
      orderProvider: createFixtureOrderProvider(),
    },
    CUSTOMER,
  );
}

async function seedApprovedChallenge(
  db: ReturnType<typeof createNodeSqlDatabase>,
  quote: Quote,
  nowMs: number,
  id = "chal-bridge-1",
  sessionId = agent.sessionId,
): Promise<string> {
  const store = createSqlCibaChallengeStore(db);
  const freshExpiry = new Date(nowMs + 15 * 60 * 1000).toISOString();
  const boundQuote: Quote = { ...quote, expiresAt: freshExpiry };
  const details = buildGuardianPurchaseAuthorizationDetails({
    quote: boundQuote,
    merchantDisplayName: MERCHANT,
    nowMs,
  });
  const challenge: PurchaseCibaChallenge = {
    id,
    status: "starting",
    customerId: CUSTOMER,
    agentId: quote.agentId,
    sessionId,
    quoteId: quote.id,
    quoteRevision: quote.revision,
    operationId: quote.operationId,
    quoteExpiresAt: boundQuote.expiresAt,
    quoteSnapshot: structuredClone(boundQuote),
    canonicalAuthorizationDetailsJson: canonicalAuthorizationDetailsJson(details),
    authReqId: "auth-req-fixture",
    pollIntervalSec: 5,
    nextPollAtMs: nowMs,
    challengeExpiresAtMs: nowMs + 300_000,
    createdAtMs: nowMs,
    decidedAtMs: null,
    consumedAtMs: null,
    failureCode: null,
  };
  await store.insertStarting(challenge);
  await store.transition(id, ["starting"], "approved", { decidedAtMs: nowMs });
  db.exec(
    "UPDATE quotes SET data = ? WHERE id = ?",
    JSON.stringify(boundQuote),
    quote.id,
  );
  return id;
}

test("CIBA bridge records approval and gates execute without verifyCustomerApproval", async () => {
  const { raw, db } = openDb();
  const ledger = ledgerWithoutVerifier(db);
  const nowMs = 1_900_000_000_000;
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  const challengeId = await seedApprovedChallenge(db, quote, nowMs);
  assert.deepEqual(await ledger.executeQuote(quote.id, agent), {
    status: "customer_verification_required",
  });
  const recorded = ledger.recordCustomerApprovalFromCibaChallenge(
    challengeId,
    human,
    quote,
    { nowMs, merchantDisplayName: MERCHANT },
  );
  assert.equal(recorded.status, "approval_recorded");
  const completed = await ledger.executeQuote(quote.id, agent);
  assert.equal(completed.status, "completed");
  raw.close();
});

test("double consumption and replay fail; challenge stays single-use", async () => {
  const { raw, db } = openDb();
  const ledger = ledgerWithoutVerifier(db);
  const nowMs = 1_900_000_010_000;
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "tea", quantity: 1, priceMinor: 1200, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  const challengeId = await seedApprovedChallenge(db, quote, nowMs);
  ledger.recordCustomerApprovalFromCibaChallenge(challengeId, human, quote, {
    nowMs,
    merchantDisplayName: MERCHANT,
  });
  assert.throws(
    () =>
      ledger.recordCustomerApprovalFromCibaChallenge(
        challengeId,
        human,
        quote,
        { nowMs: nowMs + 1, merchantDisplayName: MERCHANT },
      ),
    /challenge_already_consumed/,
  );
  raw.close();
});

test("stale cart after approval rolls back consumption", async () => {
  const { raw, db } = openDb();
  const ledger = ledgerWithoutVerifier(db);
  const nowMs = 1_900_000_020_000;
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  const challengeId = await seedApprovedChallenge(db, quote, nowMs);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 2, priceMinor: 1800, currency: "USD" },
  ]);
  assert.throws(
    () =>
      ledger.recordCustomerApprovalFromCibaChallenge(
        challengeId,
        human,
        quote,
        { nowMs, merchantDisplayName: MERCHANT },
      ),
    /stale_quote/,
  );
  const row = db
    .exec(
      "SELECT consumed_at_ms FROM purchase_ciba_challenges WHERE id = ?",
      challengeId,
    )
    .one();
  assert.equal(row?.consumed_at_ms, null);
  const approval = db
    .exec(
      "SELECT 1 AS ok FROM quote_customer_approvals WHERE quote_id = ?",
      quote.id,
    )
    .one();
  assert.equal(approval, null);
  raw.close();
});

test("expired quote rejects bridge and leaves challenge unconsumed", async () => {
  const { raw, db } = openDb();
  const ledger = ledgerWithoutVerifier(db);
  const nowMs = 1_900_000_030_000;
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  const challengeId = await seedApprovedChallenge(db, quote, nowMs);
  const expired = {
    ...quote,
    expiresAt: new Date(nowMs - 60_000).toISOString(),
  };
  raw
    .prepare("UPDATE quotes SET data = ? WHERE id = ?")
    .run(JSON.stringify(expired), quote.id);
  assert.throws(
    () =>
      recordApprovalWithConsumedChallenge(db, CUSTOMER, {
        challengeId,
        quote,
        actor: human,
      }),
    /stale_quote/,
  );
  const row = db
    .exec(
      "SELECT consumed_at_ms FROM purchase_ciba_challenges WHERE id = ?",
      challengeId,
    )
    .one();
  assert.equal(row?.consumed_at_ms, null);
  raw.close();
});

test("cross-customer human actor is forbidden", async () => {
  const { raw, db } = openDb();
  const ledger = ledgerWithoutVerifier(db);
  const nowMs = 1_900_000_040_000;
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  const challengeId = await seedApprovedChallenge(db, quote, nowMs);
  assert.throws(
    () =>
      ledger.recordCustomerApprovalFromCibaChallenge(
        challengeId,
        { kind: "human", customerId: "other-customer", scopes: [] },
        quote,
        { nowMs, merchantDisplayName: MERCHANT },
      ),
    /not_found_or_forbidden/,
  );
  raw.close();
});

test("session mismatch on cart rejects bridge", async () => {
  const { raw, db } = openDb();
  const ledger = ledgerWithoutVerifier(db);
  const nowMs = 1_900_000_050_000;
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  const challengeId = await seedApprovedChallenge(db, quote, nowMs);
  raw
    .prepare("UPDATE carts SET session_id = ? WHERE id = ?")
    .run("session-tampered", cart.id);
  assert.throws(
    () =>
      ledger.recordCustomerApprovalFromCibaChallenge(
        challengeId,
        human,
        quote,
        { nowMs, merchantDisplayName: MERCHANT },
      ),
    /challenge_session_mismatch/,
  );
  raw.close();
});

test("denied challenge status is not consumable", async () => {
  const { raw, db } = openDb();
  const ledger = ledgerWithoutVerifier(db);
  const nowMs = 1_900_000_060_000;
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  const challengeId = await seedApprovedChallenge(db, quote, nowMs);
  const store = createSqlCibaChallengeStore(db);
  await store.transition(challengeId, ["approved"], "denied", {
    decidedAtMs: nowMs + 1,
  });
  assert.throws(
    () =>
      ledger.recordCustomerApprovalFromCibaChallenge(
        challengeId,
        human,
        quote,
        { nowMs: nowMs + 2, merchantDisplayName: MERCHANT },
      ),
    /challenge_not_approved/,
  );
  raw.close();
});

test("concurrent bridge calls yield one approval", async () => {
  const { raw, db } = openDb();
  const ledger = ledgerWithoutVerifier(db);
  const nowMs = 1_900_000_070_000;
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  const challengeId = await seedApprovedChallenge(db, quote, nowMs);
  const attempts = await Promise.allSettled([
    (async () =>
      recordApprovalWithConsumedChallenge(db, CUSTOMER, {
        challengeId,
        quote,
        actor: human,
      }))(),
    (async () =>
      recordApprovalWithConsumedChallenge(db, CUSTOMER, {
        challengeId,
        quote,
        actor: human,
      }))(),
  ]);
  const fulfilled = attempts.filter((r) => r.status === "fulfilled");
  const rejected = attempts.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const completed = await ledger.executeQuote(quote.id, agent);
  assert.equal(completed.status, "completed");
  raw.close();
});

test("bounded agent session still blocked from execute after CIBA approval", async () => {
  const { raw, db } = openDb();
  const ledger = ledgerWithoutVerifier(db);
  const nowMs = 1_900_000_080_000;
  const bounded: AgentActor = {
    kind: "agent",
    customerId: CUSTOMER,
    agentId: "agent-a",
    pairwiseUserId: "user-u",
    sessionId: "bounded",
    scopes: [...AGENT_SESSION_SCOPES],
  };
  assert.ok(!bounded.scopes.includes(ORDER_EXECUTE_SCOPE));
  const cart = ledger.createCart(bounded);
  ledger.updateCart(cart.id, bounded, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, bounded, "fixture-home");
  const challengeId = await seedApprovedChallenge(
    db,
    quote,
    nowMs,
    "chal-bounded",
    bounded.sessionId,
  );
  ledger.recordCustomerApprovalFromCibaChallenge(
    challengeId,
    human,
    quote,
    { nowMs, merchantDisplayName: MERCHANT },
  );
  await assert.rejects(
    ledger.executeQuote(quote.id, bounded),
    /not_found_or_forbidden/,
  );
  raw.close();
});