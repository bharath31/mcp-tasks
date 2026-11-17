import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createMerchantLedger } from "../src/ledger.js";
import { createTrustedMerchantHost } from "../src/host.js";
import { createNodeSqlDatabase } from "../src/sql.js";
import {
  createFencedSimulatedWalletLedgerSlice,
  createSimulatedWalletOrderProvider,
  peekSimulatedWalletOrder,
  provisionSimulatedWalletFunds,
  readSimulatedWalletBalanceMinor,
} from "../src/simulated-wallet/index.js";
import {
  createFixtureApprovalVerifier,
  createFixtureCustomerAccount,
} from "./support/fixtures.js";
import type { AgentActor, HumanActor, Quote } from "../src/types.js";

const CUSTOMER = "fixture-customer";
const OTHER = "other-customer";

const agent: AgentActor = {
  kind: "agent",
  customerId: CUSTOMER,
  agentId: "agent-a",
  pairwiseUserId: "user-u",
  sessionId: "session-s",
  scopes: ["cart:write", "checkout:write", "addresses:read", "order:execute"],
};

const human: HumanActor = { kind: "human", customerId: CUSTOMER, scopes: [] };

function fencedLedger(fundMinor = 0) {
  const raw = new DatabaseSync(":memory:");
  const db = createNodeSqlDatabase(raw);
  if (fundMinor > 0) {
    provisionSimulatedWalletFunds(db, CUSTOMER, fundMinor);
  }
  const approval = createFixtureApprovalVerifier();
  const slice = createFencedSimulatedWalletLedgerSlice(db, CUSTOMER);
  const ledger = createMerchantLedger(
    db,
    {
      customerAccount: createFixtureCustomerAccount(),
      verifyCustomerApproval: approval,
      ...slice,
    },
    CUSTOMER,
  );
  const host = createTrustedMerchantHost(ledger);
  return { ledger, host, approval, slice, db, raw };
}

async function processingQuote(
  ledger: ReturnType<typeof createMerchantLedger>,
  host: ReturnType<typeof createTrustedMerchantHost>,
  approval: ReturnType<typeof createFixtureApprovalVerifier>,
) {
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote);
  await host.injectCustomerApproval(quote.id, human);
  assert.deepEqual(await ledger.executeQuote(quote.id, agent), {
    status: "processing",
  });
  return { cart, quote };
}

test("fenced wallet: abandon after provider_confirmed_absent", async () => {
  const { ledger, host, approval, raw } = fencedLedger();
  const { cart, quote } = await processingQuote(ledger, host, approval);
  assert.deepEqual(await ledger.reconcileQuote(quote.id, agent), {
    status: "provider_confirmed_absent",
  });
  assert.deepEqual(await ledger.abandonQuote(quote.id, agent), {
    status: "abandoned",
  });
  ledger.updateCart(cart.id, agent, [
    { productId: "tea", quantity: 1, priceMinor: 1200, currency: "USD" },
  ]);
  const next = await ledger.createQuote(cart.id, agent, "fixture-home");
  assert.notEqual(next.operationId, quote.operationId);
  raw.close();
});

test("fenced wallet: late place after abandon does not debit", async () => {
  const { ledger, host, approval, slice, db, raw } = fencedLedger();
  const { quote } = await processingQuote(ledger, host, approval);
  assert.deepEqual(await ledger.reconcileQuote(quote.id, agent), {
    status: "provider_confirmed_absent",
  });
  assert.deepEqual(await ledger.abandonQuote(quote.id, agent), {
    status: "abandoned",
  });
  const balanceBefore = readSimulatedWalletBalanceMinor(db, CUSTOMER);
  const placed = await slice.orderProvider.place({
    quote: structuredClone(quote),
    idempotencyKey: quote.operationId,
  });
  assert.equal(placed, null);
  assert.equal(readSimulatedWalletBalanceMinor(db, CUSTOMER), balanceBefore);
  assert.equal(peekSimulatedWalletOrder(db, quote.operationId), null);
  raw.close();
});

test("fenced wallet: zero balance stays processing without debiting", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = createNodeSqlDatabase(raw);
  const approval = createFixtureApprovalVerifier();
  const slice = createFencedSimulatedWalletLedgerSlice(db, CUSTOMER);
  const ledger = createMerchantLedger(
    db,
    {
      customerAccount: createFixtureCustomerAccount(),
      verifyCustomerApproval: approval,
      ...slice,
    },
    CUSTOMER,
  );
  const host = createTrustedMerchantHost(ledger);
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote);
  await host.injectCustomerApproval(quote.id, human);
  assert.deepEqual(await ledger.executeQuote(quote.id, agent), {
    status: "processing",
  });
  assert.equal(readSimulatedWalletBalanceMinor(db, CUSTOMER), 0);
  assert.equal(peekSimulatedWalletOrder(db, quote.operationId), null);
  raw.close();
});

test("fenced wallet: tampered quote terms rejected at place", async () => {
  const { ledger, host, approval, slice, raw } = fencedLedger();
  const { quote } = await processingQuote(ledger, host, approval);
  const tampered = structuredClone(quote);
  tampered.totalMinor = quote.totalMinor + 1;
  const placed = await slice.orderProvider.place({
    quote: tampered,
    idempotencyKey: quote.operationId,
  });
  assert.equal(placed, null);
  raw.close();
});

test("fenced wallet: unrelated idempotency key does not place", async () => {
  const { ledger, host, approval, slice, raw } = fencedLedger();
  const { quote } = await processingQuote(ledger, host, approval);
  const placed = await slice.orderProvider.place({
    quote: structuredClone(quote),
    idempotencyKey: "unrelated-key",
  });
  assert.equal(placed, null);
  raw.close();
});

test("fenced wallet: race abandon vs place yields single terminal outcome", async () => {
  const { ledger, host, approval, slice, db, raw } = fencedLedger();
  const { quote } = await processingQuote(ledger, host, approval);
  assert.deepEqual(await ledger.reconcileQuote(quote.id, agent), {
    status: "provider_confirmed_absent",
  });
  provisionSimulatedWalletFunds(db, CUSTOMER, 10_000);
  const [abandon, place] = await Promise.all([
    ledger.abandonQuote(quote.id, agent),
    slice.orderProvider.place({
      quote: structuredClone(quote),
      idempotencyKey: quote.operationId,
    }),
  ]);
  if (place) {
    assert.notEqual(abandon.status, "abandoned");
    assert.equal(
      (await ledger.reconcileQuote(quote.id, agent)).status,
      "completed",
    );
  } else {
    assert.equal(abandon.status, "abandoned");
  }
  const terminal =
    abandon.status === "abandoned"
      ? "abandoned"
      : (await ledger.reconcileQuote(quote.id, agent)).status;
  assert.ok(
    terminal === "abandoned" || terminal === "completed",
    `unexpected terminal ${terminal}`,
  );
  if (terminal === "completed") {
    assert.ok(peekSimulatedWalletOrder(db, quote.operationId)?.orderId);
  } else {
    assert.equal(peekSimulatedWalletOrder(db, quote.operationId), null);
  }
  raw.close();
});

test("fenced wallet: unfenced provider alone cannot satisfy safe abandon", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = createNodeSqlDatabase(raw);
  const approval = createFixtureApprovalVerifier();
  const ledger = createMerchantLedger(
    db,
    {
      customerAccount: createFixtureCustomerAccount(),
      verifyCustomerApproval: approval,
      orderProvider: createSimulatedWalletOrderProvider(db, CUSTOMER),
    },
    CUSTOMER,
  );
  const host = createTrustedMerchantHost(ledger);
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote);
  await host.injectCustomerApproval(quote.id, human);
  assert.deepEqual(await ledger.executeQuote(quote.id, agent), {
    status: "processing",
  });
  assert.deepEqual(await ledger.reconcileQuote(quote.id, agent), {
    status: "provider_confirmed_absent",
  });
  await assert.rejects(
    ledger.abandonQuote(quote.id, agent),
    /safe_abandon_unavailable/,
  );
  raw.close();
});

test("fenced wallet: customer mismatch on abandon is a no-op until correct call", async () => {
  const { ledger, host, approval, slice, raw } = fencedLedger();
  const { quote } = await processingQuote(ledger, host, approval);
  assert.deepEqual(await ledger.reconcileQuote(quote.id, agent), {
    status: "provider_confirmed_absent",
  });
  const wrongCustomer = { ...structuredClone(quote), customerId: OTHER };
  await slice.atomicAbandonAbsent!({
    quote: wrongCustomer,
    idempotencyKey: quote.operationId,
  });
  assert.deepEqual(await ledger.abandonQuote(quote.id, agent), {
    status: "abandoned",
  });
  raw.close();
});
