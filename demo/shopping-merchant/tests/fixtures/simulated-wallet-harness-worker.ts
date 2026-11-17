/**
 * Miniflare-only worker: simulated wallet on real DO SqlStorage (createDoSqlDatabase).
 * Not deployable; no production routes.
 */
import { DurableObject } from "cloudflare:workers";
import { AGENT_SESSION_SCOPES } from "../../src/identity/index.js";
import { createMerchantLedger } from "../../src/ledger.js";
import { createDoSqlDatabase, initMerchantSchema } from "../../src/sql.js";
import {
  createFencedSimulatedWalletLedgerSlice,
  createSimulatedWalletOrderProvider,
  peekSimulatedWalletOrder,
  provisionSimulatedWalletFunds,
  readSimulatedWalletBalanceMinor,
} from "../../src/simulated-wallet/index.js";
import type { Quote, TrustedActor } from "../../src/types.js";
import {
  createFixtureApprovalVerifier,
  createFixtureCustomerAccount,
} from "../support/fixtures.js";

const DEFAULT_CUSTOMER = "fixture-customer";

type PlaceBody = {
  customerId?: string;
  quote: Quote;
  idempotencyKey: string;
  fault?: "after-debit-before-order";
};

type LedgerRpcBody = {
  op:
    | "ledger-setup-checkout"
    | "ledger-execute-with-fault"
    | "ledger-reconcile"
    | "ledger-abandon"
    | "ledger-fenced-place";
  customerId?: string;
  quoteId?: string;
  faultBeforeLedgerComplete?: boolean;
  fenced?: boolean;
  /** Default 10_000 when not fenced; pass 0 to leave wallet unfunded. */
  provisionMinor?: number;
};

function wrapDbAfterDebitOrderFault(
  inner: ReturnType<typeof createDoSqlDatabase>,
): ReturnType<typeof createDoSqlDatabase> {
  return {
    exec(query: string, ...bindings: unknown[]) {
      if (/INSERT INTO sim_wallet_orders/i.test(query)) {
        throw new Error("harness_fault_after_debit_before_order");
      }
      return inner.exec(query, ...bindings);
    },
    transaction<T>(fn: () => T): T {
      return inner.transaction(fn);
    },
  };
}

function wrapDbBlockLedgerCompletion(
  inner: ReturnType<typeof createDoSqlDatabase>,
): ReturnType<typeof createDoSqlDatabase> {
  return {
    exec(query: string, ...bindings: unknown[]) {
      if (
        /UPDATE checkout_executions\s+SET status = 'completed'/i.test(query)
      ) {
        throw new Error("harness_fault_before_ledger_complete");
      }
      return inner.exec(query, ...bindings);
    },
    transaction<T>(fn: () => T): T {
      return inner.transaction(fn);
    },
  };
}

const agent: TrustedActor = {
  kind: "agent",
  customerId: DEFAULT_CUSTOMER,
  agentId: "agent-a",
  pairwiseUserId: "user-u",
  sessionId: "session-s",
  scopes: [...AGENT_SESSION_SCOPES, "order:execute"],
};

const human = {
  kind: "human" as const,
  customerId: DEFAULT_CUSTOMER,
  scopes: [] as string[],
};

export class SimulatedWalletStorageHarness extends DurableObject {
  private approval = createFixtureApprovalVerifier();
  private blockLedgerCompletion = false;

  private baseDb() {
    return createDoSqlDatabase(this.ctx.storage);
  }

  private dbForWallet(fault?: PlaceBody["fault"]) {
    const inner = this.baseDb();
    if (fault === "after-debit-before-order") {
      return wrapDbAfterDebitOrderFault(inner);
    }
    return inner;
  }

  private dbForLedger() {
    const inner = this.baseDb();
    if (this.blockLedgerCompletion) {
      return wrapDbBlockLedgerCompletion(inner);
    }
    return inner;
  }

  private ledger(customerId: string, fenced = false) {
    const db = this.dbForLedger();
    const wallet = fenced
      ? createFencedSimulatedWalletLedgerSlice(db, customerId)
      : { orderProvider: createSimulatedWalletOrderProvider(db, customerId) };
    return createMerchantLedger(
      db,
      {
        customerAccount: createFixtureCustomerAccount(),
        verifyCustomerApproval: this.approval,
        ...wallet,
      },
      customerId,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.searchParams.get("op");
    const customerId =
      url.searchParams.get("customerId") ??
      request.headers.get("x-nominee-customer-id") ??
      DEFAULT_CUSTOMER;

    if (op === "provision") {
      const body = (await request.json()) as {
        customerId?: string;
        amountMinor: number;
      };
      const cid = body.customerId ?? customerId;
      const db = this.baseDb();
      provisionSimulatedWalletFunds(db, cid, body.amountMinor);
      return Response.json({
        balance: readSimulatedWalletBalanceMinor(db, cid),
      });
    }

    if (op === "balance") {
      const db = this.baseDb();
      return Response.json({
        balance: readSimulatedWalletBalanceMinor(db, customerId),
      });
    }

    if (op === "place" || op === "reconcile") {
      const body = (await request.json()) as PlaceBody;
      const cid = body.customerId ?? customerId;
      const db = this.dbForWallet(body.fault);
      const wallet = createSimulatedWalletOrderProvider(db, cid);
      if (op === "place") {
        try {
          const result = await wallet.place({
            quote: body.quote,
            idempotencyKey: body.idempotencyKey,
          });
          return Response.json({
            result,
            balance: readSimulatedWalletBalanceMinor(this.baseDb(), cid),
            peek: peekSimulatedWalletOrder(this.baseDb(), body.idempotencyKey),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return Response.json(
            {
              error: message,
              balance: readSimulatedWalletBalanceMinor(this.baseDb(), cid),
              peek: peekSimulatedWalletOrder(
                this.baseDb(),
                body.idempotencyKey,
              ),
            },
            { status: 409 },
          );
        }
      }
      try {
        const result = await wallet.reconcile({
          quote: body.quote,
          idempotencyKey: body.idempotencyKey,
        });
        return Response.json({ result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: message }, { status: 409 });
      }
    }

    if (op === "peek") {
      const key = url.searchParams.get("idempotencyKey");
      if (!key) return new Response("idempotencyKey required", { status: 400 });
      const db = this.baseDb();
      return Response.json({
        peek: peekSimulatedWalletOrder(db, key),
        orderCount: db
          .exec(
            "SELECT COUNT(*) AS n FROM sim_wallet_orders WHERE customer_id = ?",
            customerId,
          )
          .one()?.n,
      });
    }

    if (op === "capture-unique-violation") {
      const db = this.baseDb();
      provisionSimulatedWalletFunds(db, customerId, 1000);
      const opId = "op-unique-probe";
      const terms = "terms-probe";
      try {
        db.transaction(() => {
          db.exec(
            `INSERT INTO sim_wallet_orders
             (idempotency_key, order_id, customer_id, quote_id, operation_id, total_minor, currency, terms_fingerprint)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            "probe-key-a",
            "order-a",
            customerId,
            "quote-a",
            opId,
            100,
            "USD",
            terms,
          );
          db.exec(
            `INSERT INTO sim_wallet_orders
             (idempotency_key, order_id, customer_id, quote_id, operation_id, total_minor, currency, terms_fingerprint)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            "probe-key-b",
            "order-b",
            customerId,
            "quote-b",
            opId,
            100,
            "USD",
            terms,
          );
        });
        return Response.json({ captured: null });
      } catch (error) {
        return Response.json({
          captured:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { message: String(error) },
        });
      }
    }

    if (op === "ledger-rpc") {
      const body = (await request.json()) as LedgerRpcBody;
      const cid = body.customerId ?? customerId;
      if (body.op === "ledger-setup-checkout") {
        const ledger = this.ledger(cid, body.fenced === true);
        const provisionMinor =
          body.provisionMinor ?? (body.fenced === true ? 0 : 10_000);
        if (provisionMinor > 0) {
          provisionSimulatedWalletFunds(this.baseDb(), cid, provisionMinor);
        }
        const cart = ledger.createCart(agent);
        ledger.updateCart(cart.id, agent, [
          { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
        ]);
        const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
        this.approval.approveForTest(quote);
        await ledger.injectCustomerApproval(quote.id, human);
        return Response.json({
          quoteId: quote.id,
          operationId: quote.operationId,
        });
      }
      if (body.op === "ledger-execute-with-fault") {
        if (!body.quoteId) {
          return new Response("quoteId required", { status: 400 });
        }
        this.blockLedgerCompletion = body.faultBeforeLedgerComplete === true;
        try {
          const ledger = this.ledger(cid, body.fenced === true);
          const result = await ledger.executeQuote(body.quoteId, agent);
          return Response.json({
            result,
            balance: readSimulatedWalletBalanceMinor(this.baseDb(), cid),
            walletPeek: peekSimulatedWalletOrder(
              this.baseDb(),
              (
                this.baseDb()
                  .exec(
                    "SELECT provider_key FROM checkout_executions WHERE quote_id = ?",
                    body.quoteId,
                  )
                  .one() as { provider_key: string } | null
              )?.provider_key ?? "",
            ),
          });
        } finally {
          this.blockLedgerCompletion = false;
        }
      }
      if (body.op === "ledger-reconcile") {
        if (!body.quoteId) {
          return new Response("quoteId required", { status: 400 });
        }
        const ledger = this.ledger(cid, body.fenced === true);
        const before = readSimulatedWalletBalanceMinor(this.baseDb(), cid);
        const result = await ledger.reconcileQuote(body.quoteId, agent);
        return Response.json({
          result,
          balanceBefore: before,
          balanceAfter: readSimulatedWalletBalanceMinor(this.baseDb(), cid),
        });
      }
      if (body.op === "ledger-abandon") {
        if (!body.quoteId) {
          return new Response("quoteId required", { status: 400 });
        }
        const ledger = this.ledger(cid, body.fenced === true);
        const before = readSimulatedWalletBalanceMinor(this.baseDb(), cid);
        const result = await ledger.abandonQuote(body.quoteId, agent);
        const db = this.baseDb();
        const providerKey = (
          db
            .exec(
              "SELECT provider_key FROM checkout_executions WHERE quote_id = ?",
              body.quoteId,
            )
            .one() as { provider_key: string } | null
        )?.provider_key;
        return Response.json({
          result,
          balanceBefore: before,
          balanceAfter: readSimulatedWalletBalanceMinor(db, cid),
          walletPeek: providerKey
            ? peekSimulatedWalletOrder(db, providerKey)
            : null,
        });
      }
      if (body.op === "ledger-fenced-place") {
        if (!body.quoteId) {
          return new Response("quoteId required", { status: 400 });
        }
        const db = this.baseDb();
        const slice = createFencedSimulatedWalletLedgerSlice(db, cid);
        const record = db
          .exec("SELECT data FROM quotes WHERE id = ?", body.quoteId)
          .one();
        if (!record) return new Response("quote missing", { status: 404 });
        const quote = JSON.parse(record.data as string);
        const providerKey = (
          db
            .exec(
              "SELECT provider_key FROM checkout_executions WHERE quote_id = ?",
              body.quoteId,
            )
            .one() as { provider_key: string } | null
        )?.provider_key;
        if (!providerKey) {
          return new Response("execution missing", { status: 409 });
        }
        const before = readSimulatedWalletBalanceMinor(db, cid);
        const placed = await slice.orderProvider.place({
          quote,
          idempotencyKey: providerKey,
        });
        return Response.json({
          placed,
          balanceBefore: before,
          balanceAfter: readSimulatedWalletBalanceMinor(db, cid),
        });
      }
      return new Response("unknown ledger op", { status: 400 });
    }

    if (op === "init-schema") {
      const db = this.baseDb();
      initMerchantSchema(db);
      return Response.json({ ok: true });
    }

    return new Response("unknown", { status: 400 });
  }
}

export default {
  async fetch(
    request: Request,
    env: { WALLET_HARNESS: DurableObjectNamespace },
  ) {
    const id = env.WALLET_HARNESS.idFromName("sim-wallet-harness");
    return env.WALLET_HARNESS.get(id).fetch(request);
  },
};
