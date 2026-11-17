import type { Quote } from "../types.js";

/** Canonical binding for idempotent wallet debits (immutable quote/financial identity). */
export function quoteTermsFingerprint(quote: Quote): string {
  return JSON.stringify({
    id: quote.id,
    operationId: quote.operationId,
    revision: quote.revision,
    customerId: quote.customerId,
    totalMinor: quote.totalMinor,
    currency: quote.currency,
  });
}

export function assertQuotePayable(quote: Quote, customerId: string): void {
  if (quote.customerId !== customerId) {
    throw new Error("sim_wallet_customer_mismatch");
  }
  if (quote.currency !== "USD") {
    throw new Error("sim_wallet_currency_invalid");
  }
  if (
    !Number.isSafeInteger(quote.totalMinor) ||
    quote.totalMinor <= 0 ||
    !quote.id ||
    !quote.operationId
  ) {
    throw new Error("sim_wallet_amount_invalid");
  }
}
