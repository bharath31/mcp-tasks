// OPT-IN live gate for FR-038: exercises the Stripe TEST-mode adapter with a real
// sk_test_ key. Not run in CI. Usage:
//   STRIPE_SECRET_KEY=sk_test_... node --import tsx scripts/verify-stripe-test.ts
// It checks the adapter only (payment, idempotent refund, metadata reconciliation).
// The authorization chain is covered by the e2e suites; this proves provider behaviour.
import {
  StripeTestPayments,
  mintDispatchGrant,
} from "../refund-desk/src/payments.js";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("STRIPE_SECRET_KEY (sk_test_...) is required");
const p = new StripeTestPayments(key);
const run = crypto.randomUUID();
const paymentId = await p.createTestPayment(
  "org_verify",
  30000,
  "USD",
  `pay:${run}`,
);
const before = await p.inspect("org_verify", paymentId);
const cmd = {
  paymentId,
  amountMinor: 15000,
  currency: "USD",
  idempotencyKey: `verify:${run}`,
};
const grant = mintDispatchGrant("clm_verify", cmd.idempotencyKey);
const a = await p.refund(cmd, grant);
const b = await p.refund(cmd, grant); // same idempotency key: must be the same refund
const found = await p.lookup(cmd);
const after = await p.inspect("org_verify", paymentId);
const ok =
  a.refundId === b.refundId &&
  found?.refundId === a.refundId &&
  after.refundedMinor === before.refundedMinor + 15000;
console.log(
  JSON.stringify(
    {
      paymentId,
      refundId: a.refundId,
      status: a.status,
      replaySame: a.refundId === b.refundId,
      lookupFound: found?.refundId === a.refundId,
      refundedMinor: after.refundedMinor,
      ok,
    },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
