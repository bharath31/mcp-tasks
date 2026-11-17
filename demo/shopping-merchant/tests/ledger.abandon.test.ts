import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createMerchantLedger } from "../src/ledger.js";
import { createTrustedMerchantHost } from "../src/host.js";
import { createNodeSqlDatabase } from "../src/sql.js";
import { createFencedFixturePorts } from "./support/fenced-provider-fixture.js";
import {
  createFixtureApprovalVerifier,
  createFixtureCustomerAccount,
  createFixtureOrderProvider,
} from "./support/fixtures.js";
import type { AgentActor, HumanActor, Quote } from "../src/types.js";

const CUSTOMER = "fixture-customer";
const agent: AgentActor = {
  kind: "agent",
  customerId: CUSTOMER,
  agentId: "agent-a",
  pairwiseUserId: "user-u",
  sessionId: "session-s",
  scopes: ["cart:write", "checkout:write", "addresses:read"],
};
const human: HumanActor = { kind: "human", customerId: CUSTOMER, scopes: [] };

function fencedLedger() {
  const db = new DatabaseSync(":memory:");
  const ports = createFencedFixturePorts(db);
  const ledger = createMerchantLedger(
    createNodeSqlDatabase(db),
    ports,
    CUSTOMER,
  );
  const host = createTrustedMerchantHost(ledger);
  return { ledger, host, ports, db };
}

function basicLedger() {
  const db = new DatabaseSync(":memory:");
  const approval = createFixtureApprovalVerifier();
  const provider = createFixtureOrderProvider();
  const ledger = createMerchantLedger(
    createNodeSqlDatabase(db),
    {
      customerAccount: createFixtureCustomerAccount(),
      verifyCustomerApproval: approval,
      orderProvider: provider,
    },
    CUSTOMER,
  );
  return { ledger, approval, provider, db };
}

async function processingQuote(
  ledger: ReturnType<typeof createMerchantLedger>,
  host: ReturnType<typeof createTrustedMerchantHost>,
  approve: (quote: Quote) => void,
  ports?: { configurePlace(mode: "success" | "null"): void },
) {
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approve(quote);
  await host.injectCustomerApproval(quote.id, human);
  ports?.configurePlace("null");
  assert.deepEqual(await ledger.executeQuote(quote.id, agent), {
    status: "processing",
  });
  return { cart, quote };
}

test("provider_confirmed_absent alone cannot abandon or unlock cart", async () => {
  const { ledger, approval, provider, db } = basicLedger();
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote);
  await ledger.injectCustomerApproval(quote.id, human);
  provider.configurePlace("throw");
  assert.deepEqual(await ledger.executeQuote(quote.id, agent), {
    status: "processing",
  });
  provider.configureReconcileAbsent(quote.operationId, true);
  assert.deepEqual(await ledger.reconcileQuote(quote.id, agent), {
    status: "provider_confirmed_absent",
  });
  await assert.rejects(ledger.abandonQuote(quote.id, agent), (err: Error) =>
    /safe_abandon_unavailable/.test(err.message),
  );
  assert.throws(
    () =>
      ledger.updateCart(cart.id, agent, [
        { productId: "tea", quantity: 1, priceMinor: 1200, currency: "USD" },
      ]),
    /checkout_processing/,
  );
  db.close();
});

test("fenced atomicAbandonAbsent abandons and allows requote on new operation", async () => {
  const { ledger, host, ports, db } = fencedLedger();
  const { cart, quote } = await processingQuote(
    ledger,
    host,
    (q) => ports.approveForTest(q),
    ports,
  );
  assert.deepEqual(await ledger.reconcileQuote(quote.id, agent), {
    status: "provider_confirmed_absent",
  });
  assert.deepEqual(await ledger.abandonQuote(quote.id, agent), {
    status: "abandoned",
  });
  assert.deepEqual(await ledger.abandonQuote(quote.id, agent), {
    status: "abandoned",
  });
  ledger.updateCart(cart.id, agent, [
    { productId: "tea", quantity: 1, priceMinor: 1200, currency: "USD" },
  ]);
  const next = await ledger.createQuote(cart.id, agent, "fixture-home");
  assert.notEqual(next.operationId, quote.operationId);
  db.close();
});

test("abandon after completion returns completed order idempotently", async () => {
  const { ledger, host, ports, db } = fencedLedger();
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  ports.approveForTest(quote);
  await host.injectCustomerApproval(quote.id, human);
  const done = await ledger.executeQuote(quote.id, agent);
  assert.equal(done.status, "completed");
  if (done.status !== "completed") throw new Error("expected completed");
  assert.deepEqual(await ledger.abandonQuote(quote.id, agent), done);
  db.close();
});

test("wrong actor cannot abandon processing checkout", async () => {
  const { ledger, host, ports, db } = fencedLedger();
  const { quote } = await processingQuote(
    ledger,
    host,
    (q) => ports.approveForTest(q),
    ports,
  );
  await assert.rejects(
    ledger.abandonQuote(quote.id, { ...agent, agentId: "other-agent" }),
    /not_found_or_forbidden/,
  );
  await assert.rejects(ledger.abandonQuote(quote.id, human), (err: Error) =>
    /not_found_or_forbidden/.test(err.message),
  );
  db.close();
});

test("adapter no-op when provider order exists leaves processing fail closed", async () => {
  const { ledger, host, ports, db } = fencedLedger();
  const { quote } = await processingQuote(
    ledger,
    host,
    (q) => ports.approveForTest(q),
    ports,
  );
  ports.configurePlace("success");
  const placed = await ports.orderProvider.place({
    quote: structuredClone(quote),
    idempotencyKey: quote.operationId,
  });
  assert.ok(placed?.id);
  assert.deepEqual(await ledger.abandonQuote(quote.id, agent), {
    status: "processing",
  });
  const cartId = (await ledger.getQuote(quote.id, agent)).cartId;
  assert.throws(
    () =>
      ledger.updateCart(cartId, agent, [
        { productId: "tea", quantity: 1, priceMinor: 1200, currency: "USD" },
      ]),
    /checkout_processing/,
  );
  db.close();
});

test("async race: placement and abandon contend; exactly one wins", async () => {
  const { ledger, host, ports, db } = fencedLedger();
  const { quote } = await processingQuote(
    ledger,
    host,
    (q) => ports.approveForTest(q),
    ports,
  );
  const [abandon, place] = await Promise.all([
    ledger.abandonQuote(quote.id, agent),
    ports.orderProvider.place({
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
  db.close();
});
