import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AGENT_SESSION_SCOPES } from "../src/identity/index.js";
import { createMerchantLedger } from "../src/ledger.js";
import { createTrustedMerchantHost } from "../src/host.js";
import { createNodeSqlDatabase } from "../src/sql.js";
import {
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
import type { SqlDatabase } from "../src/sql.js";

const CUSTOMER = "fixture-customer";
const KEY = "op-key-1";

const human: HumanActor = { kind: "human", customerId: CUSTOMER, scopes: [] };
const agent: AgentActor = {
  kind: "agent",
  customerId: CUSTOMER,
  agentId: "agent-a",
  pairwiseUserId: "user-u",
  sessionId: "session-s",
  scopes: [...AGENT_SESSION_SCOPES, "order:execute"],
};

function sampleQuote(overrides: Partial<Quote> = {}): Quote {
  const base: Quote = {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    revision: 1,
    cartId: "cart-1",
    cartVersion: 1,
    customerId: CUSTOMER,
    agentId: "agent-a",
    items: [
      {
        productId: "mug",
        name: "Mug",
        quantity: 1,
        priceMinor: 1800,
        currency: "USD",
      },
    ],
    subtotalMinor: 1800,
    taxMinor: 0,
    shippingMinor: 0,
    totalMinor: 1800,
    currency: "USD",
    destination: {
      id: "fixture-home",
      customerId: CUSTOMER,
      label: "Home",
      version: "1",
      trustedForAgentCheckout: true,
      destination: { country: "US" },
    },
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    requirement: "customer_verification",
  };
  return { ...base, ...overrides };
}

function memoryDb() {
  const raw = new DatabaseSync(":memory:");
  return { raw, db: createNodeSqlDatabase(raw) };
}

/** Corrupts the post-debit balance read so provider must roll back. */
function createCorruptingBalanceDb(inner: SqlDatabase): SqlDatabase {
  let balanceSelects = 0;
  return {
    exec(query: string, ...bindings: unknown[]) {
      const cursor = inner.exec(query, ...bindings);
      const isBalanceSelect =
        /SELECT balance_minor FROM sim_wallet_balances/i.test(query);
      if (!isBalanceSelect) return cursor;
      return {
        one() {
          balanceSelects += 1;
          const row = cursor.one();
          if (balanceSelects >= 2 && row) {
            return { balance_minor: (row.balance_minor as number) + 1 };
          }
          return row;
        },
        all: () => cursor.all(),
      };
    },
    transaction<T>(fn: () => T): T {
      balanceSelects = 0;
      return inner.transaction(fn);
    },
  };
}

test("wallet starts unfunded; place returns null without order row", async () => {
  const { raw, db } = memoryDb();
  const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
  const quote = sampleQuote();
  assert.equal(await wallet.place({ quote, idempotencyKey: KEY }), null);
  assert.equal(peekSimulatedWalletOrder(db, KEY), null);
  assert.equal(readSimulatedWalletBalanceMinor(db, CUSTOMER), 0);
  raw.close();
});

test("provision credits safe integer cents; place debits once", async () => {
  const { raw, db } = memoryDb();
  provisionSimulatedWalletFunds(db, CUSTOMER, 5000);
  const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
  const quote = sampleQuote({ totalMinor: 1800 });
  const first = await wallet.place({ quote, idempotencyKey: KEY });
  const second = await wallet.place({ quote, idempotencyKey: KEY });
  assert.ok(first?.id);
  assert.deepEqual(second, first);
  assert.equal(readSimulatedWalletBalanceMinor(db, CUSTOMER), 3200);
  assert.equal(peekSimulatedWalletOrder(db, KEY)?.orderId, first.id);
  raw.close();
});

test("altered line items with same idempotency key and total fail closed", async () => {
  const { raw, db } = memoryDb();
  provisionSimulatedWalletFunds(db, CUSTOMER, 5000);
  const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
  const quote = sampleQuote();
  const quoteId = quote.id;
  await wallet.place({ quote, idempotencyKey: KEY });
  const mutated = sampleQuote({
    id: quoteId,
    items: [
      {
        productId: "pen",
        name: "Pen",
        quantity: 2,
        priceMinor: 900,
        currency: "USD",
      },
    ],
    subtotalMinor: 1800,
    totalMinor: 1800,
  });
  await assert.rejects(
    wallet.place({ quote: mutated, idempotencyKey: KEY }),
    /sim_wallet_idempotency_conflict/,
  );
  await assert.rejects(
    wallet.reconcile({ quote: mutated, idempotencyKey: KEY }),
    /sim_wallet_idempotency_conflict/,
  );
  assert.equal(readSimulatedWalletBalanceMinor(db, CUSTOMER), 3200);
  raw.close();
});

test("altered destination with same idempotency key fail closed", async () => {
  const { raw, db } = memoryDb();
  provisionSimulatedWalletFunds(db, CUSTOMER, 5000);
  const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
  const quote = sampleQuote();
  await wallet.place({ quote, idempotencyKey: KEY });
  const mutated = sampleQuote({
    id: quote.id,
    destination: {
      ...quote.destination,
      id: "fixture-work",
      label: "Work",
      destination: { country: "US", city: "Denver" },
    },
  });
  await assert.rejects(
    wallet.place({ quote: mutated, idempotencyKey: KEY }),
    /sim_wallet_idempotency_conflict/,
  );
  await assert.rejects(
    wallet.reconcile({ quote: mutated, idempotencyKey: KEY }),
    /sim_wallet_idempotency_conflict/,
  );
  raw.close();
});

test("mismatched idempotency terms fail closed", async () => {
  const { raw, db } = memoryDb();
  provisionSimulatedWalletFunds(db, CUSTOMER, 5000);
  const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
  const quote = sampleQuote();
  await wallet.place({ quote, idempotencyKey: KEY });
  const other = sampleQuote({ id: crypto.randomUUID(), totalMinor: 2000 });
  await assert.rejects(
    wallet.place({ quote: other, idempotencyKey: KEY }),
    /sim_wallet_idempotency_conflict/,
  );
  await assert.rejects(
    wallet.reconcile({ quote: other, idempotencyKey: KEY }),
    /sim_wallet_idempotency_conflict/,
  );
  assert.equal(readSimulatedWalletBalanceMinor(db, CUSTOMER), 3200);
  raw.close();
});

test("cross-customer quote is rejected", async () => {
  const { raw, db } = memoryDb();
  provisionSimulatedWalletFunds(db, CUSTOMER, 5000);
  const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
  const quote = sampleQuote({ customerId: "other-customer" });
  await assert.rejects(
    wallet.place({ quote, idempotencyKey: KEY }),
    /sim_wallet_customer_mismatch/,
  );
  raw.close();
});

test("insufficient balance leaves ledger unchanged", async () => {
  const { raw, db } = memoryDb();
  provisionSimulatedWalletFunds(db, CUSTOMER, 1000);
  const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
  const quote = sampleQuote({ totalMinor: 1800 });
  assert.equal(await wallet.place({ quote, idempotencyKey: KEY }), null);
  assert.equal(peekSimulatedWalletOrder(db, KEY), null);
  assert.equal(readSimulatedWalletBalanceMinor(db, CUSTOMER), 1000);
  raw.close();
});

test("reconcile distinguishes absent from confirmed order", async () => {
  const { raw, db } = memoryDb();
  provisionSimulatedWalletFunds(db, CUSTOMER, 5000);
  const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
  const quote = sampleQuote();
  assert.deepEqual(await wallet.reconcile({ quote, idempotencyKey: KEY }), {
    id: "",
    status: "absent",
  });
  const placed = await wallet.place({ quote, idempotencyKey: KEY });
  assert.deepEqual(await wallet.reconcile({ quote, idempotencyKey: KEY }), {
    id: placed!.id,
  });
  raw.close();
});

test("restart-safe reconcile after durable place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sim-wallet-"));
  const path = join(dir, "wallet.sqlite");
  const quote = sampleQuote();
  {
    const raw = new DatabaseSync(path);
    const db = createNodeSqlDatabase(raw);
    provisionSimulatedWalletFunds(db, CUSTOMER, 5000);
    const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
    const placed = await wallet.place({ quote, idempotencyKey: KEY });
    assert.ok(placed?.id);
    raw.close();
  }
  {
    const raw = new DatabaseSync(path);
    const db = createNodeSqlDatabase(raw);
    const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
    const found = await wallet.reconcile({ quote, idempotencyKey: KEY });
    assert.deepEqual(found, { id: peekSimulatedWalletOrder(db, KEY)!.orderId });
    assert.equal(readSimulatedWalletBalanceMinor(db, CUSTOMER), 3200);
    raw.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test("concurrent place attempts cannot double-spend", async () => {
  const { raw, db } = memoryDb();
  provisionSimulatedWalletFunds(db, CUSTOMER, 1800);
  const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
  const quote = sampleQuote({ totalMinor: 1800 });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      wallet.place({ quote, idempotencyKey: `race-${index}` }),
    ),
  );
  const succeeded = results.filter(
    (r) => r.status === "fulfilled" && r.value?.id,
  );
  const debited = results.filter(
    (r) =>
      r.status === "rejected" &&
      (r.reason as Error).message === "sim_wallet_operation_debited",
  );
  assert.equal(succeeded.length, 1);
  assert.equal(debited.length, 7);
  assert.equal(readSimulatedWalletBalanceMinor(db, CUSTOMER), 0);
  assert.equal(
    db
      .exec(
        "SELECT COUNT(*) AS n FROM sim_wallet_orders WHERE customer_id = ?",
        CUSTOMER,
      )
      .one()?.n,
    1,
  );
  raw.close();
});

test("different idempotency keys for one operation never debit twice", async () => {
  const { raw, db } = memoryDb();
  provisionSimulatedWalletFunds(db, CUSTOMER, 5000);
  const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
  const quote = sampleQuote();
  const first = await wallet.place({ quote, idempotencyKey: "key-a" });
  assert.ok(first?.id);
  await assert.rejects(
    wallet.place({ quote, idempotencyKey: "key-b" }),
    /sim_wallet_operation_debited/,
  );
  assert.equal(readSimulatedWalletBalanceMinor(db, CUSTOMER), 3200);
  assert.equal(peekSimulatedWalletOrder(db, "key-b"), null);
  raw.close();
});

test("reconcile after quote expiry uses snapshot terms, not wall clock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sim-wallet-expired-"));
  const path = join(dir, "wallet.sqlite");
  const quote = sampleQuote({
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  {
    const raw = new DatabaseSync(path);
    const db = createNodeSqlDatabase(raw);
    provisionSimulatedWalletFunds(db, CUSTOMER, 5000);
    const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
    const placed = await wallet.place({ quote, idempotencyKey: KEY });
    assert.ok(placed?.id);
    raw.close();
  }
  {
    const raw = new DatabaseSync(path);
    const db = createNodeSqlDatabase(raw);
    const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
    const found = await wallet.reconcile({ quote, idempotencyKey: KEY });
    assert.deepEqual(found, { id: peekSimulatedWalletOrder(db, KEY)!.orderId });
    raw.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test("balance inconsistency after debit rolls back without order row", async () => {
  const { raw, db: inner } = memoryDb();
  const db = createCorruptingBalanceDb(inner);
  provisionSimulatedWalletFunds(inner, CUSTOMER, 5000);
  const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
  const quote = sampleQuote();
  await assert.rejects(
    wallet.place({ quote, idempotencyKey: KEY }),
    /sim_wallet_balance_inconsistency/,
  );
  assert.equal(peekSimulatedWalletOrder(inner, KEY), null);
  assert.equal(readSimulatedWalletBalanceMinor(inner, CUSTOMER), 5000);
  raw.close();
});

test("provision rejects balance overflow", () => {
  const { raw, db } = memoryDb();
  provisionSimulatedWalletFunds(db, CUSTOMER, Number.MAX_SAFE_INTEGER - 10);
  assert.throws(
    () => provisionSimulatedWalletFunds(db, CUSTOMER, 100),
    /sim_wallet_balance_overflow/,
  );
  raw.close();
});

test("ledger end-to-end with simulated wallet provider", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = createNodeSqlDatabase(raw);
  const approval = createFixtureApprovalVerifier();
  const wallet = createSimulatedWalletOrderProvider(db, CUSTOMER);
  provisionSimulatedWalletFunds(db, CUSTOMER, 10_000);
  const ledger = createMerchantLedger(
    db,
    {
      customerAccount: createFixtureCustomerAccount(),
      verifyCustomerApproval: approval,
      orderProvider: wallet,
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
  const done = await host.executeQuote(quote.id, agent);
  assert.equal(done.status, "completed");
  if (done.status !== "completed") return;
  assert.equal(readSimulatedWalletBalanceMinor(db, CUSTOMER), 8200);
  assert.ok(peekSimulatedWalletOrder(db, quote.operationId));
  raw.close();
});
