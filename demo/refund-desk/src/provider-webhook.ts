import Stripe from "stripe";
import type { TaskAuthority } from "@task-authority/sdk";

/** Verify provider evidence before forwarding it; the service alone decides claim matching. */
export function stripeRefundWebhook(options: {
  signingSecret: string;
  organizationId: string;
  authority: TaskAuthority;
}) {
  return async (request: Request): Promise<Response> => {
    const signature = request.headers.get("stripe-signature");
    if (!signature) return new Response(null, { status: 401 });
    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(
        await request.text(),
        signature,
        options.signingSecret,
      );
    } catch {
      return new Response(null, { status: 401 });
    }
    if (event.livemode) return new Response(null, { status: 400 });
    if (
      !["refund.created", "refund.updated", "refund.failed"].includes(
        event.type,
      )
    )
      return new Response(null, { status: 204 });
    const refund = event.data.object as Stripe.Refund;
    const payment =
      typeof refund.payment_intent === "string"
        ? refund.payment_intent
        : refund.payment_intent?.id;
    if (!payment) return new Response(null, { status: 400 });
    const result = await options.authority.providerEvents.report({
      organizationId: options.organizationId,
      amountMinor: refund.amount,
      currency: refund.currency,
      providerReference: refund.id,
      claimId: refund.metadata?.authority_claim_id,
      action: "refund:create",
      resource: `payment:${payment}`,
    });
    return new Response(JSON.stringify(result), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
}
