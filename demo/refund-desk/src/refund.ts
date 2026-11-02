// Business-side facts for a refund. Customer-owned; nothing here is authorization.
import type { Payment } from "./policy.js";
import type { Task } from "./repository.js";

/** Opaque business-state version bound into the operation digest. */
export const stateVersion = (p: Payment & { currency: string }) =>
  `${p.amountMinor}:${p.refundedMinor}:${p.currency}`;

/** The canonical, integer-minor-unit facts the approval will bind to. */
export const refundArguments = (t: Task, p: Payment) => ({
  merchant: t.orgId,
  orderId: t.request.orderId,
  paymentId: t.request.paymentId,
  amountMinor: t.request.amountMinor,
  currency: t.request.currency,
  destination: "original_payment_method",
  ...(t.request.exceptionNote
    ? { exceptionNote: t.request.exceptionNote }
    : {}),
});

/** Provider command; the operation key doubles as the provider idempotency key. */
export const refundCommand = (t: Task) => ({
  paymentId: t.request.paymentId,
  amountMinor: t.request.amountMinor,
  currency: t.request.currency,
  idempotencyKey: t.operationKey,
});
