// CONTRACT test against a local FAKE Stripe HTTP server. This is NOT Stripe
// test mode: it proves our adapter's request shape (idempotency key, metadata,
// grant gating, test-key guard). FR-038's live gate stays open until it is run
// with a real sk_test_ key (scripts/verify-stripe-test.ts).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  StripeTestPayments,
  mintDispatchGrant,
} from "../../../demo/refund-desk/src/payments.js";

type Seen = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  form: URLSearchParams;
};
let server: Server;
let port: number;
const seen: Seen[] = [];
const refunds: Array<Record<string, unknown>> = [];
const byKey = new Map<string, Record<string, unknown>>();

before(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const u = new URL(req.url!, "http://x");
    seen.push({
      method: req.method!,
      path: u.pathname,
      headers: req.headers,
      form,
    });
    const send = (o: unknown, status = 200) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "request-id": "req_fake",
      });
      res.end(JSON.stringify(o));
    };
    if (req.method === "GET" && u.pathname.startsWith("/v1/payment_intents/"))
      return send({
        id: u.pathname.split("/").pop(),
        object: "payment_intent",
        amount: 30000,
        amount_received: 30000,
        currency: "usd",
        latest_charge: {
          id: "ch_1",
          object: "charge",
          amount_refunded: refunds.reduce(
            (a, r) => a + (r.amount as number),
            0,
          ),
        },
      });
    if (req.method === "POST" && u.pathname === "/v1/refunds") {
      const key = String(req.headers["idempotency-key"]);
      const prior = byKey.get(key);
      if (prior) return send(prior);
      const r = {
        id: `re_fake_${refunds.length + 1}`,
        object: "refund",
        amount: Number(form.get("amount")),
        currency: "usd",
        status: "succeeded",
        payment_intent: form.get("payment_intent"),
        metadata: { operation_key: form.get("metadata[operation_key]") },
      };
      refunds.push(r);
      byKey.set(key, r);
      return send(r);
    }
    if (req.method === "GET" && u.pathname === "/v1/refunds")
      return send({
        object: "list",
        data: refunds.filter(
          (r) => r.payment_intent === u.searchParams.get("payment_intent"),
        ),
        has_more: false,
        url: "/v1/refunds",
      });
    send({ error: { message: "not found" } }, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

const adapter = () =>
  new StripeTestPayments("sk_test_dummy_not_a_real_key", {
    host: "127.0.0.1",
    port,
    protocol: "http",
  });
const cmd = {
  paymentId: "pi_fake_1",
  amountMinor: 15000,
  currency: "USD",
  idempotencyKey: "org_northstar:refund:pi_fake_1:742:15000",
};

test("live and malformed keys are refused at construction", () => {
  assert.throws(
    () => new StripeTestPayments("sk_live_abc"),
    /test-mode key required/,
  );
  assert.throws(
    () => new StripeTestPayments("pk_test_abc"),
    /test-mode key required/,
  );
  assert.throws(() => new StripeTestPayments(""), /test-mode key required/);
});

test("no authorized grant, no network call to the provider", async () => {
  const before = seen.length;
  await assert.rejects(
    adapter().refund(cmd, {
      claimId: "clm_x",
      operationKey: cmd.idempotencyKey,
    }),
    /refused_without_authorized_claim/,
  );
  assert.equal(seen.length, before);
});

test("refund uses the operation key as the Stripe idempotency key and tags metadata; replay returns the same refund", async () => {
  const p = adapter();
  const grant = mintDispatchGrant("clm_1", cmd.idempotencyKey);
  const a = await p.refund(cmd, grant);
  const b = await p.refund(cmd, grant);
  assert.equal(a.refundId, b.refundId);
  assert.equal(
    refunds.length,
    1,
    "one refund object for one logical operation",
  );
  const post = seen.filter(
    (s) => s.method === "POST" && s.path === "/v1/refunds",
  )[0]!;
  assert.equal(post.headers["idempotency-key"], cmd.idempotencyKey);
  assert.match(String(post.headers.authorization), /^Bearer sk_test_/);
  assert.equal(post.form.get("amount"), "15000", "integer minor units");
  assert.equal(post.form.get("payment_intent"), "pi_fake_1");
  assert.equal(post.form.get("metadata[operation_key]"), cmd.idempotencyKey);
  assert.deepEqual(
    { status: a.status, amountMinor: a.amountMinor, currency: a.currency },
    { status: "succeeded", amountMinor: 15000, currency: "USD" },
  );
});

test("reconciliation finds the refund by operation-key metadata, and reports absence honestly", async () => {
  const p = adapter();
  assert.equal(
    (
      await p.lookup({
        paymentId: "pi_fake_1",
        idempotencyKey: cmd.idempotencyKey,
      })
    )?.refundId,
    "re_fake_1",
  );
  assert.equal(
    await p.lookup({
      paymentId: "pi_fake_1",
      idempotencyKey: "some:other:key",
    }),
    null,
  );
  assert.equal(
    (await p.inspect("org_northstar", "pi_fake_1")).refundedMinor,
    15000,
  );
});
