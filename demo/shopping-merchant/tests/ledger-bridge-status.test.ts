import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  customerFacingChallengeStatus,
  isPurchaseCibaLedgerBridged,
} from "../src/ciba/ledger-bridge-status.js";
import { initCibaChallengeSchema } from "../src/ciba/schema.js";
import { createSqlCibaChallengeStore } from "../src/ciba/sql-ciba-challenge-store.js";
import { createMerchantLedger, ORDER_EXECUTE_SCOPE } from "../src/ledger.js";
import { createNodeSqlDatabase, initMerchantSchema } from "../src/sql.js";
import type { AgentActor } from "../src/types.js";
import {
  createFixtureCustomerAccount,
  createFixtureOrderProvider,
} from "./support/fixtures.js";

const CUSTOMER = "fixture-customer";
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

test("customer-facing status stays pending until ledger bridge completes", async () => {
  assert.equal(
    customerFacingChallengeStatus("approved", false, "store"),
    "polling",
  );
  assert.equal(
    customerFacingChallengeStatus("approved", false, "sanitized"),
    "pending",
  );
  assert.equal(customerFacingChallengeStatus("approved", true), "approved");
  assert.equal(customerFacingChallengeStatus("denied", false), "denied");

  const raw = new DatabaseSync(":memory:");
  const db = createNodeSqlDatabase(raw);
  initMerchantSchema(db);
  initCibaChallengeSchema(db);
  const ledger = createMerchantLedger(
    db,
    {
      customerAccount: createFixtureCustomerAccount(),
      verifyCustomerApproval: async () => false,
      orderProvider: createFixtureOrderProvider(),
    },
    CUSTOMER,
  );
  const store = createSqlCibaChallengeStore(db);
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  const challengeId = "chal-status";
  await store.insertStarting({
    id: challengeId,
    status: "starting",
    customerId: CUSTOMER,
    agentId: quote.agentId,
    sessionId: agent.sessionId,
    quoteId: quote.id,
    quoteRevision: quote.revision,
    operationId: quote.operationId,
    quoteExpiresAt: quote.expiresAt,
    quoteSnapshot: structuredClone(quote),
    canonicalAuthorizationDetailsJson: "[]",
    authReqId: "auth-fixture",
    pollIntervalSec: 5,
    nextPollAtMs: 0,
    challengeExpiresAtMs: Date.now() + 300_000,
    createdAtMs: Date.now(),
    decidedAtMs: null,
    consumedAtMs: null,
    failureCode: null,
  });
  await store.transition(challengeId, ["starting"], "approved", {
    decidedAtMs: Date.now(),
  });
  const row = (await store.get(challengeId))!;
  assert.equal(isPurchaseCibaLedgerBridged(ledger, row, quote), false);
  db.exec(
    "UPDATE purchase_ciba_challenges SET consumed_at_ms = ? WHERE id = ?",
    Date.now(),
    challengeId,
  );
  const consumed = (await store.get(challengeId))!;
  assert.equal(isPurchaseCibaLedgerBridged(ledger, consumed, quote), false);
  db.exec(
    `INSERT INTO quote_customer_approvals
      (quote_id, operation_id, revision, customer_id, approved_at)
     VALUES (?, ?, ?, ?, ?)`,
    quote.id,
    quote.operationId,
    quote.revision,
    CUSTOMER,
    new Date().toISOString(),
  );
  assert.equal(isPurchaseCibaLedgerBridged(ledger, consumed, quote), true);
  raw.close();
});
