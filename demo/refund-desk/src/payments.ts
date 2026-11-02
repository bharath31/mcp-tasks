// Provider adapter. Customer-owned: Task Authority never sees provider credentials.
import type { Pool } from "pg";
import Stripe from "stripe";

export type PaymentSnapshot = {
  paymentId: string;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
};
export type RefundStatus = "succeeded" | "pending" | "failed";
export type ProviderRefund = {
  refundId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  status: RefundStatus;
};
export type RefundCommand = {
  paymentId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
};

export class ProviderUnavailable extends Error {}
export class ProviderOutcomeUnknown extends Error {}

/** Proof that a service claim was authorized. Only the workflow can mint one. */
const grants = new WeakSet<object>();
export type DispatchGrant = {
  readonly claimId: string;
  readonly operationKey: string;
};
export function mintDispatchGrant(
  claimId: string,
  operationKey: string,
): DispatchGrant {
  const g = Object.freeze({ claimId, operationKey });
  grants.add(g);
  return g;
}

export interface Payments {
  readonly mode: "stripe-test" | "simulator";
  inspect(orgId: string, paymentId: string): Promise<PaymentSnapshot>;
  /** Side effect. The adapter refuses to run without an authorized claim. */
  refund(cmd: RefundCommand, grant: DispatchGrant): Promise<ProviderRefund>;
  /** Read-only reconciliation by the operation's idempotency key. */
  lookup(
    cmd: Pick<RefundCommand, "paymentId" | "idempotencyKey">,
  ): Promise<ProviderRefund | null>;
  /** Test/demo only: a paid order to refund. Idempotent on the key. */
  createTestPayment(
    orgId: string,
    amountMinor: number,
    currency: string,
    idempotencyKey: string,
  ): Promise<string>;
}

function assertGrant(cmd: RefundCommand, grant: DispatchGrant) {
  if (!grants.has(grant) || grant.operationKey !== cmd.idempotencyKey)
    throw new Error("refund_refused_without_authorized_claim");
}

export class StripeTestPayments implements Payments {
  readonly mode = "stripe-test" as const;
  private stripe: Stripe;
  constructor(
    secretKey: string,
    opts: { host?: string; port?: number; protocol?: "http" | "https" } = {},
  ) {
    // Test mode only: a live key is a configuration error, not a warning.
    if (!/^(sk|rk)_test_/.test(secretKey))
      throw new Error("Stripe test-mode key required (sk_test_/rk_test_)");
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 0, ...opts });
  }
  private map(r: Stripe.Refund, currency: string): ProviderRefund {
    const status: RefundStatus =
      r.status === "succeeded"
        ? "succeeded"
        : r.status === "failed" || r.status === "canceled"
          ? "failed"
          : "pending";
    return {
      refundId: r.id,
      paymentId: String(r.payment_intent),
      amountMinor: r.amount,
      currency: currency.toUpperCase(),
      status,
    };
  }
  async inspect(_org: string, paymentId: string): Promise<PaymentSnapshot> {
    const pi = await this.stripe.paymentIntents.retrieve(paymentId, {
      expand: ["latest_charge"],
    });
    const charge = pi.latest_charge as Stripe.Charge | null;
    return {
      paymentId,
      amountMinor: pi.amount_received,
      refundedMinor: charge?.amount_refunded ?? 0,
      currency: pi.currency.toUpperCase(),
    };
  }
  async refund(cmd: RefundCommand, grant: DispatchGrant) {
    assertGrant(cmd, grant);
    // Same operation key == same Stripe idempotency key: a replay cannot refund twice
    // inside Stripe's idempotency window; outside it we reconcile by metadata first.
    const r = await this.stripe.refunds.create(
      {
        payment_intent: cmd.paymentId,
        amount: cmd.amountMinor,
        metadata: {
          operation_key: cmd.idempotencyKey,
          authority_claim_id: grant.claimId,
        },
      },
      { idempotencyKey: cmd.idempotencyKey },
    );
    return this.map(r, cmd.currency);
  }
  async lookup(cmd: Pick<RefundCommand, "paymentId" | "idempotencyKey">) {
    const list = await this.stripe.refunds.list({
      payment_intent: cmd.paymentId,
      limit: 100,
    });
    const hit = list.data.find(
      (r) => r.metadata?.operation_key === cmd.idempotencyKey,
    );
    return hit ? this.map(hit, hit.currency) : null;
  }
  /** Test-mode helper for demos: a confirmed PaymentIntent using Stripe's test card. */
  async createTestPayment(
    _orgId: string,
    amountMinor: number,
    currency: string,
    idempotencyKey: string,
  ) {
    const pi = await this.stripe.paymentIntents.create(
      {
        amount: amountMinor,
        currency: currency.toLowerCase(),
        payment_method: "pm_card_visa",
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      },
      { idempotencyKey },
    );
    return pi.id;
  }
}

export type Faults = {
  /** Provider call succeeds but the response is lost (the dangerous case). */
  loseResponseAfterSuccess?: number;
  /** Provider unavailable before doing anything. */
  unavailable?: number;
  /** Next refund is created `pending` (settles on a later lookup). */
  pending?: number;
  /** Next refund fails definitively. */
  fail?: number;
};

/** DETERMINISTIC SIMULATOR. Not Stripe and never presented as Stripe. */
export class SimulatedPayments implements Payments {
  readonly mode = "simulator" as const;
  faults: Faults = {};
  /** Every refund request that reached the provider, for "no call without claim" assertions. */
  readonly calls: RefundCommand[] = [];
  constructor(
    private pool: Pool,
    private now: () => number = Date.now,
  ) {}
  async createTestPayment(
    orgId: string,
    amountMinor: number,
    currency: string,
    idempotencyKey: string,
  ) {
    const h = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`${orgId}|${idempotencyKey}`),
        ),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return this.createPayment(
      orgId,
      amountMinor,
      currency,
      `pi_sim_${h.slice(0, 16)}`,
    );
  }
  async createPayment(
    orgId: string,
    amountMinor: number,
    currency = "USD",
    paymentId = `pi_sim_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
  ) {
    await this.pool.query(
      "insert into refund_desk.sim_payments (payment_id, org_id, amount_minor, currency) values ($1,$2,$3,$4) on conflict do nothing",
      [paymentId, orgId, amountMinor, currency],
    );
    return paymentId;
  }
  private take(k: keyof Faults) {
    if ((this.faults[k] ?? 0) > 0) {
      this.faults[k]!--;
      return true;
    }
    return false;
  }
  async inspect(orgId: string, paymentId: string): Promise<PaymentSnapshot> {
    const r = await this.pool.query(
      "select * from refund_desk.sim_payments where payment_id=$1 and org_id=$2",
      [paymentId, orgId],
    );
    if (!r.rows[0]) throw new Error("payment_not_found");
    return {
      paymentId,
      amountMinor: r.rows[0].amount_minor,
      refundedMinor: r.rows[0].refunded_minor,
      currency: r.rows[0].currency,
    };
  }
  async refund(cmd: RefundCommand, grant: DispatchGrant) {
    assertGrant(cmd, grant);
    this.calls.push(cmd);
    if (this.take("unavailable"))
      throw new ProviderUnavailable("simulated provider outage");
    const existing = await this.lookup(cmd);
    if (existing) return existing; // provider-side idempotency on the key
    const status: RefundStatus = this.take("fail")
      ? "failed"
      : this.take("pending")
        ? "pending"
        : "succeeded";
    const refundId = `re_sim_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const p = (
        await c.query(
          "select amount_minor, refunded_minor, currency from refund_desk.sim_payments where payment_id=$1 for update",
          [cmd.paymentId],
        )
      ).rows[0];
      if (!p || cmd.amountMinor > p.amount_minor - p.refunded_minor)
        throw new Error("amount_exceeds_refundable_balance");
      await c.query(
        "insert into refund_desk.sim_refunds (refund_id, payment_id, idempotency_key, amount_minor, status, created_at) values ($1,$2,$3,$4,$5,$6)",
        [
          refundId,
          cmd.paymentId,
          cmd.idempotencyKey,
          cmd.amountMinor,
          status,
          new Date(this.now()).toISOString(),
        ],
      );
      if (status !== "failed")
        await c.query(
          "update refund_desk.sim_payments set refunded_minor = refunded_minor + $2 where payment_id=$1",
          [cmd.paymentId, cmd.amountMinor],
        );
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    if (this.take("loseResponseAfterSuccess"))
      throw new ProviderOutcomeUnknown(
        "simulated lost response after provider success",
      );
    return {
      refundId,
      paymentId: cmd.paymentId,
      amountMinor: cmd.amountMinor,
      currency: cmd.currency,
      status,
    };
  }
  async lookup(cmd: Pick<RefundCommand, "paymentId" | "idempotencyKey">) {
    const r = await this.pool.query(
      "select r.*, p.currency from refund_desk.sim_refunds r join refund_desk.sim_payments p using (payment_id) where r.idempotency_key=$1",
      [cmd.idempotencyKey],
    );
    const x = r.rows[0];
    if (!x) return null;
    // A pending simulated refund settles the first time it is observed again.
    if (x.status === "pending")
      await this.pool.query(
        "update refund_desk.sim_refunds set status='succeeded' where refund_id=$1",
        [x.refund_id],
      );
    return {
      refundId: x.refund_id,
      paymentId: x.payment_id,
      amountMinor: x.amount_minor,
      currency: x.currency,
      status: (x.status === "pending" ? "pending" : x.status) as RefundStatus,
    };
  }
}
