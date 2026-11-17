import type { Quote, QuoteItemSnapshot, TrustedDestination } from "../types.js";

export class GuardianTransactionDetailsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GuardianTransactionDetailsError";
    this.code = code;
  }
}

/** Material strings are encoded verbatim; leading/trailing whitespace is rejected, not stripped. */
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      `${field} must be a string`,
    );
  }
  if (value !== value.trim()) {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      `${field} must not have leading or trailing whitespace`,
    );
  }
  if (!value) {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      `${field} must be non-empty`,
    );
  }
  return value;
}

function requireSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      `${field} must be a safe integer`,
    );
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  const n = requireSafeInteger(value, field);
  if (n <= 0) {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      `${field} must be positive`,
    );
  }
  return n;
}

function safeAdd(a: number, b: number, label: string): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      `${label} overflow`,
    );
  }
  return sum;
}

function requireUsdCurrency(value: unknown, field: string): "USD" {
  if (value !== "USD") {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      `${field} must be USD`,
    );
  }
  return "USD";
}

function validateItem(item: QuoteItemSnapshot, index: number): void {
  requireNonEmptyString(item.productId, `items[${index}].productId`);
  requireNonEmptyString(item.name, `items[${index}].name`);
  requirePositiveSafeInteger(item.quantity, `items[${index}].quantity`);
  requireSafeInteger(item.priceMinor, `items[${index}].priceMinor`);
  if (item.priceMinor < 0) {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      `items[${index}].priceMinor must be non-negative`,
    );
  }
  requireUsdCurrency(item.currency, `items[${index}].currency`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function validateDestination(destination: TrustedDestination): void {
  requireNonEmptyString(destination.id, "destination.id");
  requireNonEmptyString(destination.customerId, "destination.customerId");
  requireNonEmptyString(destination.label, "destination.label");
  requireNonEmptyString(destination.version, "destination.version");
  if (typeof destination.trustedForAgentCheckout !== "boolean") {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      "destination.trustedForAgentCheckout must be boolean",
    );
  }
  if (!isPlainRecord(destination.destination)) {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      "destination.destination must be a plain object",
    );
  }
}

/** Fail closed on shape, arithmetic, currency, and expiry before encoding. */
export function validateQuoteForGuardianDetails(
  quote: Quote,
  nowMs: number,
): void {
  requireNonEmptyString(quote.id, "quote.id");
  requireNonEmptyString(quote.operationId, "quote.operationId");
  requirePositiveSafeInteger(quote.revision, "quote.revision");
  requireNonEmptyString(quote.cartId, "quote.cartId");
  requireSafeInteger(quote.cartVersion, "quote.cartVersion");
  requireNonEmptyString(quote.customerId, "quote.customerId");
  if (quote.agentId !== null && typeof quote.agentId !== "string") {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      "quote.agentId must be null or string",
    );
  }
  if (quote.agentId !== null) {
    requireNonEmptyString(quote.agentId, "quote.agentId");
  }
  if (!Array.isArray(quote.items) || quote.items.length === 0) {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      "quote.items must be a non-empty array",
    );
  }
  quote.items.forEach((item, index) => validateItem(item, index));

  const currency = requireUsdCurrency(quote.currency, "quote.currency");
  void currency;

  const subtotalMinor = requireSafeInteger(
    quote.subtotalMinor,
    "subtotalMinor",
  );
  const taxMinor = requireSafeInteger(quote.taxMinor, "taxMinor");
  const shippingMinor = requireSafeInteger(
    quote.shippingMinor,
    "shippingMinor",
  );
  const totalMinor = requireSafeInteger(quote.totalMinor, "totalMinor");
  for (const [field, value] of [
    ["subtotalMinor", subtotalMinor],
    ["taxMinor", taxMinor],
    ["shippingMinor", shippingMinor],
    ["totalMinor", totalMinor],
  ] as const) {
    if (value < 0) {
      throw new GuardianTransactionDetailsError(
        "invalid_quote",
        `${field} must be non-negative`,
      );
    }
  }

  let computedSubtotal = 0;
  for (let i = 0; i < quote.items.length; i += 1) {
    const item = quote.items[i]!;
    const line = item.quantity * item.priceMinor;
    if (!Number.isSafeInteger(line)) {
      throw new GuardianTransactionDetailsError(
        "invalid_quote",
        `items[${i}] line total overflow`,
      );
    }
    computedSubtotal = safeAdd(computedSubtotal, line, "subtotal");
  }
  if (computedSubtotal !== subtotalMinor) {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      "subtotalMinor does not match line items",
    );
  }

  const sumParts = safeAdd(
    safeAdd(subtotalMinor, taxMinor, "tax"),
    shippingMinor,
    "shipping",
  );
  if (sumParts !== totalMinor) {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      "totalMinor does not match subtotal + tax + shipping",
    );
  }

  validateDestination(quote.destination);
  if (quote.destination.customerId !== quote.customerId) {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      "destination.customerId must match quote.customerId",
    );
  }

  const expiresAt = requireNonEmptyString(quote.expiresAt, "quote.expiresAt");
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      "quote.expiresAt is not a valid timestamp",
    );
  }
  if (expiryMs <= nowMs) {
    throw new GuardianTransactionDetailsError(
      "quote_expired",
      "quote has expired",
    );
  }

  if (quote.requirement !== "customer_verification") {
    throw new GuardianTransactionDetailsError(
      "invalid_quote",
      "unsupported quote requirement",
    );
  }
}
