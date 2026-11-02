import assert from "node:assert/strict";
import { test } from "node:test";
import Stripe from "stripe";
import { TaskAuthority } from "@task-authority/sdk";
import { stripeRefundWebhook } from "../../../demo/refund-desk/src/provider-webhook.js";

test("signed Stripe refund evidence forwards the trusted merchant, provider reference and claim; invalid signatures never reach authority", async () => {
  const calls: any[] = [];
  const authority = new TaskAuthority({
    baseUrl: "https://authority.test",
    getAccessToken: async () => "backend",
    fetch: async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ matched: false, bypassDetected: true });
    },
  });
  const secret = "whsec_local_fixture";
  const handle = stripeRefundWebhook({
    signingSecret: secret,
    organizationId: "org_trusted",
    authority,
  });
  const body = JSON.stringify({
    id: "evt_1",
    type: "refund.created",
    livemode: false,
    data: {
      object: {
        id: "re_1",
        amount: 5000,
        currency: "usd",
        payment_intent: "pi_1",
        metadata: {
          authority_claim_id: "cl_1",
          organizationId: "org_attacker",
        },
      },
    },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
  });
  const req = (payload: string, sig: string) =>
    new Request("https://refund.test/api/provider/refunds", {
      method: "POST",
      headers: { "stripe-signature": sig },
      body: payload,
    });
  assert.equal((await handle(req(body, "invalid"))).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await handle(req(body, signature))).status, 202);
  assert.deepEqual(calls[0], {
    organizationId: "org_trusted",
    amountMinor: 5000,
    currency: "usd",
    providerReference: "re_1",
    claimId: "cl_1",
    action: "refund:create",
    resource: "payment:pi_1",
  });
  const live = body.replace('"livemode":false', '"livemode":true');
  assert.equal(
    (
      await handle(
        req(
          live,
          Stripe.webhooks.generateTestHeaderString({ payload: live, secret }),
        ),
      )
    ).status,
    400,
  );
  assert.equal(calls.length, 1);
});
