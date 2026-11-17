import type { Quote, QuoteItemSnapshot, TrustedDestination } from "../types.js";

function sortJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortJsonValue(record[key]);
  }
  return sorted;
}

function assertUsdMinorField(
  name: string,
  value: number,
  opts: { allowZero?: boolean } = {},
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (!opts.allowZero && value === 0)
  ) {
    throw new Error("sim_wallet_amount_invalid");
  }
}

function canonicalQuoteItem(item: QuoteItemSnapshot): QuoteItemSnapshot {
  if (
    typeof item.productId !== "string" ||
    item.productId.length === 0 ||
    typeof item.name !== "string" ||
    item.name.length === 0 ||
    !Number.isSafeInteger(item.quantity) ||
    item.quantity <= 0 ||
    !Number.isSafeInteger(item.priceMinor) ||
    item.priceMinor <= 0 ||
    item.currency !== "USD"
  ) {
    throw new Error("sim_wallet_quote_invalid");
  }
  return {
    productId: item.productId,
    name: item.name,
    quantity: item.quantity,
    priceMinor: item.priceMinor,
    currency: "USD",
  };
}

function canonicalDestination(destination: TrustedDestination): object {
  if (
    typeof destination.id !== "string" ||
    destination.id.length === 0 ||
    typeof destination.customerId !== "string" ||
    destination.customerId.length === 0 ||
    typeof destination.label !== "string" ||
    typeof destination.version !== "string" ||
    destination.version.length === 0 ||
    typeof destination.trustedForAgentCheckout !== "boolean" ||
    typeof destination.destination !== "object" ||
    destination.destination === null ||
    Array.isArray(destination.destination)
  ) {
    throw new Error("sim_wallet_quote_invalid");
  }
  return {
    id: destination.id,
    customerId: destination.customerId,
    label: destination.label,
    version: destination.version,
    trustedForAgentCheckout: destination.trustedForAgentCheckout,
    destination: sortJsonValue(destination.destination),
  };
}

/** Validates quote fields bound into {@link quoteTermsFingerprint}. */
export function assertQuoteTermsBindable(quote: Quote): void {
  if (
    typeof quote.id !== "string" ||
    quote.id.length === 0 ||
    typeof quote.operationId !== "string" ||
    quote.operationId.length === 0 ||
    !Number.isSafeInteger(quote.revision) ||
    quote.revision <= 0 ||
    typeof quote.cartId !== "string" ||
    quote.cartId.length === 0 ||
    !Number.isSafeInteger(quote.cartVersion) ||
    quote.cartVersion <= 0 ||
    typeof quote.customerId !== "string" ||
    quote.customerId.length === 0 ||
    quote.currency !== "USD" ||
    typeof quote.expiresAt !== "string" ||
    quote.expiresAt.length === 0 ||
    quote.requirement !== "customer_verification" ||
    !Array.isArray(quote.items) ||
    quote.items.length === 0
  ) {
    throw new Error("sim_wallet_quote_invalid");
  }
  if (quote.agentId !== null && typeof quote.agentId !== "string") {
    throw new Error("sim_wallet_quote_invalid");
  }
  assertUsdMinorField("subtotalMinor", quote.subtotalMinor, {
    allowZero: true,
  });
  assertUsdMinorField("taxMinor", quote.taxMinor, { allowZero: true });
  assertUsdMinorField("shippingMinor", quote.shippingMinor, {
    allowZero: true,
  });
  assertUsdMinorField("totalMinor", quote.totalMinor);
  for (const item of quote.items) {
    canonicalQuoteItem(item);
  }
  canonicalDestination(quote.destination);
}

/**
 * Canonical binding for idempotent wallet debits (immutable quote/financial identity).
 * Omits wall-clock enforcement; `expiresAt` is part of the snapshot, not a reconcile gate.
 */
export function quoteTermsFingerprint(quote: Quote): string {
  assertQuoteTermsBindable(quote);
  const items = quote.items.map((item) => canonicalQuoteItem(item));
  const payload = {
    id: quote.id,
    operationId: quote.operationId,
    revision: quote.revision,
    cartId: quote.cartId,
    cartVersion: quote.cartVersion,
    customerId: quote.customerId,
    agentId: quote.agentId,
    items,
    subtotalMinor: quote.subtotalMinor,
    taxMinor: quote.taxMinor,
    shippingMinor: quote.shippingMinor,
    totalMinor: quote.totalMinor,
    currency: quote.currency,
    destination: canonicalDestination(quote.destination),
    expiresAt: quote.expiresAt,
    requirement: quote.requirement,
  };
  return JSON.stringify(payload);
}

export function assertQuotePayable(quote: Quote, customerId: string): void {
  if (quote.customerId !== customerId) {
    throw new Error("sim_wallet_customer_mismatch");
  }
  if (quote.currency !== "USD") {
    throw new Error("sim_wallet_currency_invalid");
  }
  assertQuoteTermsBindable(quote);
}
