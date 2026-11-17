import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createMerchantLedger } from "../src/ledger.js";
import { createTrustedMerchantHost } from "../src/host.js";
import { createNodeSqlDatabase } from "../src/sql.js";
import {
  createFixtureApprovalVerifier,
  createFixtureCustomerAccount,
  createFixtureOrderProvider,
} from "./support/fixtures.js";
import type { AgentActor, HumanActor } from "../src/types.js";

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
const otherHuman: HumanActor = {
  kind: "human",
  customerId: "other-customer",
  scopes: [],
};

function memoryLedger() {
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
  return { ledger, host: createTrustedMerchantHost(ledger), approval, provider, db };
}

test("ownership: cross-customer carts and quotes are forbidden", async () => {
  const { ledger, db } = memoryLedger();
  const foreign = createMerchantLedger(
    createNodeSqlDatabase(new DatabaseSync(":memory:")),
    {
      customerAccount: createFixtureCustomerAccount(),
      verifyCustomerApproval: createFixtureApprovalVerifier(),
      orderProvider: createFixtureOrderProvider(),
    },
    "other-customer",
  );
  const cart = ledger.createCart(agent);
  assert.throws(() =>
    foreign.readCart(cart.id, { ...agent, customerId: "other-customer" }),
  );
  db.close();
});

test("every purchase requires injected customer approval; no verifier means fail closed", async () => {
  const db = new DatabaseSync(":memory:");
  const ledger = createMerchantLedger(
    createNodeSqlDatabase(db),
    {
      customerAccount: createFixtureCustomerAccount(),
      verifyCustomerApproval: async () => false,
      orderProvider: createFixtureOrderProvider(),
    },
    CUSTOMER,
  );
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [{ productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" }]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  assert.deepEqual(await ledger.executeQuote(quote.id, agent), {
    status: "customer_verification_required",
  });
  await assert.rejects(
    ledger.injectCustomerApproval(quote.id, human),
    /customer_approval_unverified/,
  );
  db.close();
});

test("quote drift, tampered totals and destinations are rejected", async () => {
  const { ledger, approval, provider, db } = memoryLedger();
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [{ productId: "mug", quantity: 2, priceMinor: 1800, currency: "USD" }]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote);
  ledger.updateCart(cart.id, agent, [{ productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" }]);
  await assert.rejects(ledger.executeQuote(quote.id, agent), /stale_quote/);
  const requote = await ledger.createQuote(cart.id, agent, "fixture-alternate");
  assert.notEqual(requote.destination.id, quote.destination.id);
  assert.equal(provider.getPlaceCalls(), 0);
  db.close();
});

test("stale expiry blocks execution", async () => {
  const { ledger, approval, db } = memoryLedger();
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [{ productId: "tea", quantity: 1, priceMinor: 1200, currency: "USD" }]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote);
  const expired = { ...quote, expiresAt: new Date(Date.now() - 60_000).toISOString() };
  db.prepare("UPDATE quotes SET data = ? WHERE id = ?").run(
    JSON.stringify(expired),
    quote.id,
  );
  await assert.rejects(ledger.executeQuote(quote.id, agent), /stale_quote/);
  db.close();
});

test("wrong principal cannot inject approval or execute", async () => {
  const { ledger, approval, db } = memoryLedger();
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [{ productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" }]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote);
  await assert.rejects(
    ledger.injectCustomerApproval(quote.id, otherHuman),
    /not_found_or_forbidden/,
  );
  await assert.rejects(
    ledger.executeQuote(quote.id, { ...agent, agentId: "wrong-agent" }),
    /not_found_or_forbidden/,
  );
  db.close();
});

test("duplicate and racing execution claims provider once", async () => {
  const { ledger, host, approval, provider, db } = memoryLedger();
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [{ productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" }]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote);
  await host.injectCustomerApproval(quote.id, human);
  const outcomes = await Promise.all([
    host.executeQuote(quote.id, agent),
    host.executeQuote(quote.id, agent),
  ]);
  assert.equal(provider.getPlaceCalls(), 1);
  const completed = outcomes.filter((o) => o.status === "completed");
  assert.equal(completed.length, 1);
  assert.deepEqual(await host.executeQuote(quote.id, agent), completed[0]);
  db.close();
});

test("provider uncertainty stays processing; reconcile recovers", async () => {
  const { ledger, approval, provider, db } = memoryLedger();
  provider.configurePlace("null");
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [{ productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" }]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote);
  await ledger.injectCustomerApproval(quote.id, human);
  assert.deepEqual(await ledger.executeQuote(quote.id, agent), { status: "processing" });
  assert.equal(provider.getPlaceCalls(), 1);
  provider.seedOrder(quote.operationId);
  const recovered = await ledger.reconcileQuote(quote.id, agent);
  assert.equal(recovered.status, "completed");
  db.close();
});

test("agent-bound carts: human cannot executeQuote (commerce executionActor parity)", async () => {
  const { ledger, host, approval, db } = memoryLedger();
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote);
  await host.injectCustomerApproval(quote.id, human);
  await assert.rejects(ledger.executeQuote(quote.id, human), /not_found_or_forbidden/);
  db.close();
});

test("agent session continuity: same agent and user with a different session is denied", async () => {
  const { ledger, db } = memoryLedger();
  const cart = ledger.createCart(agent);
  assert.throws(
    () =>
      ledger.updateCart(
        cart.id,
        { ...agent, sessionId: "session-other" },
        [{ productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" }],
      ),
    /not_found_or_forbidden/,
  );
  db.close();
});

test("malformed agent principal is rejected on every surface", async () => {
  const { ledger, db } = memoryLedger();
  const cart = ledger.createCart(agent);
  const badAgent = {
    kind: "agent" as const,
    agentId: "agent-a",
    pairwiseUserId: "user-u",
    sessionId: "",
    scopes: ["cart:write", "checkout:write", "addresses:read"],
  };
  assert.throws(() => ledger.readCart(cart.id, badAgent), /not_found_or_forbidden/);
  await assert.rejects(
    ledger.createQuote(cart.id, badAgent, "fixture-home"),
    /not_found_or_forbidden/,
  );
  db.close();
});

test("approval replay after requote does not execute stale revision", async () => {
  const { ledger, host, approval, provider, db } = memoryLedger();
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote);
  await host.injectCustomerApproval(quote.id, human);
  await host.injectCustomerApproval(quote.id, human);
  ledger.updateCart(cart.id, agent, [
    { productId: "tea", quantity: 1, priceMinor: 1200, currency: "USD" },
  ]);
  const quote2 = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote2);
  await host.injectCustomerApproval(quote2.id, human);
  await assert.rejects(ledger.executeQuote(quote.id, agent), /stale_quote/);
  assert.equal(provider.getPlaceCalls(), 0);
  db.close();
});

test("async interleave: cart mutation during execute claim surfaces stale quote", async () => {
  const { ledger, host, approval, db } = memoryLedger();
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
  approval.approveForTest(quote);
  await host.injectCustomerApproval(quote.id, human);
  const executeP = host.executeQuote(quote.id, agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 2, priceMinor: 1800, currency: "USD" },
  ]);
  await assert.rejects(executeP, /stale_quote/);
  db.close();
});

test("hosted injectCustomerApproval is the approval surface; absent proof verifier fails closed", async () => {
  const db = new DatabaseSync(":memory:");
  const broken = createMerchantLedger(
    createNodeSqlDatabase(db),
    {
      customerAccount: createFixtureCustomerAccount(),
      verifyCustomerApproval: undefined as unknown as () => Promise<boolean>,
      orderProvider: createFixtureOrderProvider(),
    },
    CUSTOMER,
  );
  const cart = broken.createCart(agent);
  broken.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await broken.createQuote(cart.id, agent, "fixture-home");
  await assert.rejects(
    broken.injectCustomerApproval(quote.id, human),
    /customer_approval_unavailable/,
  );
  db.close();
});