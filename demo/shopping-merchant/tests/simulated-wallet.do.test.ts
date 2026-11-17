/**
 * Simulated wallet on real DO SqlStorage (Miniflare + createDoSqlDatabase).
 *
 * Concurrency note: a single Durable Object processes one fetch handler at a time,
 * so parallel dispatchFetch calls to the same DO instance are serialized by the
 * runtime — not true parallel writers. Parallel tests here still validate fencing
 * under interleaved RPC scheduling, matching production per-customer DO semantics.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { Quote } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const CUSTOMER = "fixture-customer";
const KEY = "do-op-key-1";

function matchesUniqueViolationHeuristic(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("unique constraint") ||
    lower.includes("constraint failed") ||
    lower.includes("sqlite_constraint_unique")
  );
}

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

let mf: Miniflare;
let harnessScript: string;

function walletHarnessMiniflare(): Miniflare {
  return new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "wallet-harness",
          modules: true,
          script: harnessScript,
          compatibilityDate: "2026-10-09",
          durableObjects: {
            WALLET_HARNESS: {
              className: "SimulatedWalletStorageHarness",
              useSQLite: true,
            },
          },
        },
      ],
    }),
  );
}

async function provision(mfInstance: Miniflare, amountMinor: number) {
  const response = await mfInstance.dispatchFetch(
    "http://wallet/?op=provision",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: CUSTOMER, amountMinor }),
    },
  );
  assert.equal(response.status, 200);
  return (await response.json()) as { balance: number };
}

before(async () => {
  const bundle = await build({
    entryPoints: [join(here, "fixtures/simulated-wallet-harness-worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    target: "es2023",
  });
  harnessScript = bundle.outputFiles[0]!.text;
  mf = walletHarnessMiniflare();
});

after(async () => {
  await mf?.dispose();
});

test("DO SqlStorage: fund → place → duplicate place → reconcile", async () => {
  const fresh = walletHarnessMiniflare();
  await provision(fresh, 5000);
  const quote = sampleQuote();
  const placeOnce = await fresh.dispatchFetch("http://wallet/?op=place", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quote, idempotencyKey: KEY }),
  });
  assert.equal(placeOnce.status, 200);
  const first = (await placeOnce.json()) as {
    result: { id: string };
    balance: number;
  };
  assert.ok(first.result.id);
  assert.equal(first.balance, 3200);

  const placeDup = await fresh.dispatchFetch("http://wallet/?op=place", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quote, idempotencyKey: KEY }),
  });
  const second = (await placeDup.json()) as { result: { id: string } };
  assert.equal(second.result.id, first.result.id);

  const reconBefore = await fresh.dispatchFetch("http://wallet/?op=reconcile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quote, idempotencyKey: KEY }),
  });
  const absentQuote = sampleQuote({ id: crypto.randomUUID() });
  const reconAbsent = await fresh.dispatchFetch("http://wallet/?op=reconcile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quote: absentQuote,
      idempotencyKey: "missing-key",
    }),
  });
  assert.equal(reconBefore.status, 200);
  const confirmed = (await reconBefore.json()) as { result: { id: string } };
  assert.equal(confirmed.result.id, first.result.id);
  const absent = (await reconAbsent.json()) as {
    result: { id: string; status?: string };
  };
  assert.equal(absent.result.status, "absent");
  await fresh.dispose();
});

test("DO SqlStorage: durability within same DO instance (restart between RPCs)", async () => {
  const fresh = walletHarnessMiniflare();
  await provision(fresh, 5000);
  const quote = sampleQuote();
  const placed = await fresh.dispatchFetch("http://wallet/?op=place", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quote, idempotencyKey: KEY }),
  });
  const body = (await placed.json()) as { result: { id: string } };
  assert.ok(body.result.id);

  const later = await fresh.dispatchFetch(
    `http://wallet/?op=peek&idempotencyKey=${encodeURIComponent(KEY)}`,
  );
  const peek = (await later.json()) as {
    peek: { orderId: string } | null;
    orderCount: number;
  };
  assert.equal(peek.peek?.orderId, body.result.id);
  assert.equal(peek.orderCount, 1);

  const recovered = await fresh.dispatchFetch("http://wallet/?op=reconcile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quote, idempotencyKey: KEY }),
  });
  const recon = (await recovered.json()) as { result: { id: string } };
  assert.equal(recon.result.id, body.result.id);
  await fresh.dispose();
});

test("DO SqlStorage: competing place same operation with distinct idempotency keys", async () => {
  const fresh = walletHarnessMiniflare();
  await provision(fresh, 1800);
  const quote = sampleQuote({
    operationId: crypto.randomUUID(),
    totalMinor: 1800,
  });
  const [respA, respB] = await Promise.all([
    fresh.dispatchFetch("http://wallet/?op=place", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote, idempotencyKey: "race-a" }),
    }),
    fresh.dispatchFetch("http://wallet/?op=place", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote, idempotencyKey: "race-b" }),
    }),
  ]);
  const outcomes = await Promise.all([
    respA.json() as Promise<{
      result?: { id: string };
      error?: string;
      balance: number;
    }>,
    respB.json() as Promise<{
      result?: { id: string };
      error?: string;
      balance: number;
    }>,
  ]);
  const successes = outcomes.filter((o) => o.result?.id);
  const debited = outcomes.filter(
    (o) => o.error === "sim_wallet_operation_debited",
  );
  assert.equal(successes.length, 1);
  assert.equal(debited.length, 1);
  assert.equal(successes[0]!.balance, 0);
  const balance = await fresh.dispatchFetch("http://wallet/?op=balance");
  const bal = (await balance.json()) as { balance: number };
  assert.equal(bal.balance, 0);
  await fresh.dispose();
});

test("DO SqlStorage: transactionSync rolls back debit when order insert is forced to fail", async () => {
  const fresh = walletHarnessMiniflare();
  await provision(fresh, 5000);
  const quote = sampleQuote();
  const response = await fresh.dispatchFetch("http://wallet/?op=place", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quote,
      idempotencyKey: KEY,
      fault: "after-debit-before-order",
    }),
  });
  assert.equal(response.status, 409);
  const body = (await response.json()) as {
    error: string;
    balance: number;
    peek: unknown;
  };
  assert.equal(body.error, "harness_fault_after_debit_before_order");
  assert.equal(body.balance, 5000);
  assert.equal(body.peek, null);
  await fresh.dispose();
});

test("DO SqlStorage: captures UNIQUE violation message shape for heuristic alignment", async () => {
  const fresh = walletHarnessMiniflare();
  const response = await fresh.dispatchFetch(
    "http://wallet/?op=capture-unique-violation",
  );
  const body = (await response.json()) as {
    captured: { message: string } | null;
  };
  assert.ok(body.captured?.message);
  assert.equal(
    matchesUniqueViolationHeuristic(body.captured.message),
    true,
    `unexpected SqlStorage UNIQUE message: ${body.captured.message}`,
  );
  await fresh.dispose();
});

test("DO SqlStorage: ledger crash after wallet place completes via reconcile without double debit", async () => {
  const fresh = walletHarnessMiniflare();
  const setup = await fresh.dispatchFetch("http://wallet/?op=ledger-rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "ledger-setup-checkout", customerId: CUSTOMER }),
  });
  assert.equal(setup.status, 200);
  const { quoteId } = (await setup.json()) as { quoteId: string };

  const crashed = await fresh.dispatchFetch("http://wallet/?op=ledger-rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      op: "ledger-execute-with-fault",
      customerId: CUSTOMER,
      quoteId,
      faultBeforeLedgerComplete: true,
    }),
  });
  assert.equal(crashed.status, 200);
  const crashBody = (await crashed.json()) as {
    result: { status: string };
    balance: number;
    walletPeek: { orderId: string } | null;
  };
  assert.equal(crashBody.result.status, "processing");
  assert.equal(crashBody.balance, 8200);
  assert.ok(crashBody.walletPeek?.orderId);

  const recon = await fresh.dispatchFetch("http://wallet/?op=ledger-rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      op: "ledger-reconcile",
      customerId: CUSTOMER,
      quoteId,
    }),
  });
  const reconBody = (await recon.json()) as {
    result: { status: string; order?: { id: string } };
    balanceBefore: number;
    balanceAfter: number;
  };
  assert.equal(reconBody.result.status, "completed");
  assert.equal(reconBody.result.order?.id, crashBody.walletPeek!.orderId);
  assert.equal(reconBody.balanceBefore, 8200);
  assert.equal(reconBody.balanceAfter, 8200);
  await fresh.dispose();
});
