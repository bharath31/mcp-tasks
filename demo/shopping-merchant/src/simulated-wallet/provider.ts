import type { SqlDatabase } from "../sql.js";
import type { OrderProviderPort, Quote } from "../types.js";
import { assertQuotePayable, quoteTermsFingerprint } from "./quote-terms.js";
import { initSimulatedWalletSchema } from "./schema.js";

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function assertOrderTermsMatch(
  row: Record<string, unknown>,
  terms: string,
  quote: Quote,
): void {
  if (
    row.terms_fingerprint !== terms ||
    row.quote_id !== quote.id ||
    row.customer_id !== quote.customerId ||
    row.total_minor !== quote.totalMinor ||
    row.currency !== quote.currency
  ) {
    throw new Error("sim_wallet_idempotency_conflict");
  }
}

/**
 * Restart-durable simulated wallet implementing {@link OrderProviderPort}.
 * Debits integer USD cents only; never calls live payment processors.
 *
 * **Not human approval.** Spending authority still requires the merchant host to verify
 * customer consent and quote terms before invoking `place`.
 */
export function createSimulatedWalletOrderProvider(
  db: SqlDatabase,
  customerId: string,
): OrderProviderPort {
  if (!nonempty(customerId)) {
    throw new Error("sim_wallet_customer_required");
  }
  initSimulatedWalletSchema(db);

  return {
    async place({ quote, idempotencyKey }) {
      if (!nonempty(idempotencyKey)) {
        throw new Error("sim_wallet_idempotency_required");
      }
      assertQuotePayable(quote, customerId);
      const terms = quoteTermsFingerprint(quote);

      return db.transaction(() => {
        const prior = db
          .exec(
            "SELECT order_id, terms_fingerprint, quote_id, customer_id, total_minor, currency FROM sim_wallet_orders WHERE idempotency_key = ?",
            idempotencyKey,
          )
          .one();
        if (prior) {
          assertOrderTermsMatch(prior, terms, quote);
          return { id: prior.order_id as string };
        }

        db.exec(
          "INSERT OR IGNORE INTO sim_wallet_balances (customer_id, balance_minor) VALUES (?, 0)",
          customerId,
        );
        const wallet = db
          .exec(
            "SELECT balance_minor FROM sim_wallet_balances WHERE customer_id = ?",
            customerId,
          )
          .one();
        const balanceBefore = wallet ? (wallet.balance_minor as number) : 0;
        if (balanceBefore < quote.totalMinor) {
          return null;
        }
        db.exec(
          `UPDATE sim_wallet_balances
           SET balance_minor = balance_minor - ?
           WHERE customer_id = ? AND balance_minor >= ?`,
          quote.totalMinor,
          customerId,
          quote.totalMinor,
        );
        const after = db
          .exec(
            "SELECT balance_minor FROM sim_wallet_balances WHERE customer_id = ?",
            customerId,
          )
          .one();
        const balanceAfter = after
          ? (after.balance_minor as number)
          : balanceBefore;
        if (balanceAfter !== balanceBefore - quote.totalMinor) {
          return null;
        }

        const orderId = crypto.randomUUID();
        db.exec(
          `INSERT INTO sim_wallet_orders
           (idempotency_key, order_id, customer_id, quote_id, operation_id, total_minor, currency, terms_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          idempotencyKey,
          orderId,
          quote.customerId,
          quote.id,
          quote.operationId,
          quote.totalMinor,
          quote.currency,
          terms,
        );
        return { id: orderId };
      });
    },

    async reconcile({ quote, idempotencyKey }) {
      if (!nonempty(idempotencyKey)) {
        throw new Error("sim_wallet_idempotency_required");
      }
      assertQuotePayable(quote, customerId);
      const terms = quoteTermsFingerprint(quote);
      const row = db
        .exec(
          "SELECT order_id, terms_fingerprint, quote_id, customer_id, total_minor, currency FROM sim_wallet_orders WHERE idempotency_key = ?",
          idempotencyKey,
        )
        .one();
      if (!row) {
        return { id: "", status: "absent" };
      }
      assertOrderTermsMatch(row, terms, quote);
      return { id: row.order_id as string };
    },
  };
}

export function peekSimulatedWalletOrder(
  db: SqlDatabase,
  idempotencyKey: string,
): { orderId: string; terms: string } | null {
  initSimulatedWalletSchema(db);
  const row = db
    .exec(
      "SELECT order_id, terms_fingerprint FROM sim_wallet_orders WHERE idempotency_key = ?",
      idempotencyKey,
    )
    .one();
  if (!row) return null;
  return {
    orderId: row.order_id as string,
    terms: row.terms_fingerprint as string,
  };
}
