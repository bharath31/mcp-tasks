import type { SqlDatabase } from "../sql.js";
import type {
  AtomicAbandonAbsent,
  MerchantLedgerPorts,
  OrderProviderPort,
  Quote,
} from "../types.js";
import { assertQuotePayable, quoteTermsFingerprint } from "./quote-terms.js";
import {
  createSimulatedWalletOrderProvider,
  placeSimulatedWalletOrderWithinTransaction,
} from "./provider.js";
import { initSimulatedWalletSchema } from "./schema.js";

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function persistedQuoteTermsMatch(db: SqlDatabase, quote: Quote): boolean {
  const snapshot = db
    .exec("SELECT data FROM quotes WHERE id = ?", quote.id)
    .one();
  if (!snapshot) return false;
  let stored: Quote;
  try {
    stored = JSON.parse(snapshot.data as string) as Quote;
  } catch {
    return false;
  }
  return quoteTermsFingerprint(stored) === quoteTermsFingerprint(quote);
}

/**
 * True when the ledger has a processing execution for this exact quote snapshot and provider key.
 * Must run inside the same durable transaction as wallet placement.
 */
export function ledgerAllowsFencedWalletPlace(
  db: SqlDatabase,
  quote: Quote,
  idempotencyKey: string,
): boolean {
  const execution = db
    .exec(
      "SELECT quote_id, customer_id, status, provider_key FROM checkout_executions WHERE operation_id = ?",
      idempotencyKey,
    )
    .one();
  if (
    !execution ||
    execution.status !== "processing" ||
    execution.quote_id !== quote.id ||
    execution.customer_id !== quote.customerId ||
    execution.provider_key !== idempotencyKey
  ) {
    return false;
  }
  if (Date.now() >= Date.parse(quote.expiresAt)) {
    return false;
  }
  return persistedQuoteTermsMatch(db, quote);
}

function atomicAbandonAbsentWithinTransaction(
  db: SqlDatabase,
  quote: Quote,
  idempotencyKey: string,
): void {
  initSimulatedWalletSchema(db);
  const execution = db
    .exec(
      "SELECT quote_id, customer_id, status, provider_key FROM checkout_executions WHERE operation_id = ?",
      idempotencyKey,
    )
    .one();
  if (
    !execution ||
    execution.status !== "processing" ||
    execution.quote_id !== quote.id ||
    execution.customer_id !== quote.customerId ||
    execution.provider_key !== idempotencyKey
  ) {
    return;
  }
  if (
    db
      .exec(
        "SELECT 1 AS ok FROM sim_wallet_orders WHERE idempotency_key = ?",
        idempotencyKey,
      )
      .one()
  ) {
    return;
  }
  db.exec(
    `UPDATE checkout_executions
     SET status = 'abandoned'
     WHERE operation_id = ? AND status = 'processing'`,
    idempotencyKey,
  );
}

/**
 * Ledger-coordinated simulated wallet: placement and safe abandonment share the customer DO SQLite.
 * Does not supply customerAccount or verifyCustomerApproval — merge at the DO host when wiring ports.
 */
export function createFencedSimulatedWalletLedgerSlice(
  db: SqlDatabase,
  customerId: string,
): Pick<MerchantLedgerPorts, "orderProvider" | "atomicAbandonAbsent"> {
  if (!nonempty(customerId)) {
    throw new Error("sim_wallet_customer_required");
  }
  const wallet = createSimulatedWalletOrderProvider(db, customerId);

  const orderProvider: OrderProviderPort = {
    async place({ quote, idempotencyKey }) {
      if (!nonempty(idempotencyKey)) {
        throw new Error("sim_wallet_idempotency_required");
      }
      assertQuotePayable(quote, customerId);
      return db.transaction(() => {
        if (!ledgerAllowsFencedWalletPlace(db, quote, idempotencyKey)) {
          return null;
        }
        return placeSimulatedWalletOrderWithinTransaction(
          db,
          customerId,
          quote,
          idempotencyKey,
        );
      });
    },
    reconcile: wallet.reconcile.bind(wallet),
  };

  const atomicAbandonAbsent: AtomicAbandonAbsent = async ({
    quote,
    idempotencyKey,
  }) => {
    if (quote.customerId !== customerId) {
      return;
    }
    assertQuotePayable(quote, customerId);
    db.transaction(() =>
      atomicAbandonAbsentWithinTransaction(db, quote, idempotencyKey),
    );
  };

  return { orderProvider, atomicAbandonAbsent };
}
