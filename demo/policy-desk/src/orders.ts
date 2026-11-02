// Labelled payment SIMULATOR. Adaptation of demo/refund-desk SimulatedPayments:
// that class imports the Stripe SDK and needs a Node pg Pool, so the same
// contract (inspect / refund idempotent on the operation key) is implemented
// here against the policy_desk schema. No provider key is ever read.
import type { Db } from "../../../auth0/service/src/store.js";
import { MAX_ORDERS_PER_GENERATION } from "./env.js";

export type Order = {
  orderId: string;
  customer: string;
  item: string;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
};
const SAMPLES: Array<[string, string, number]> = [
  ["Dana Whitfield", "Trail jacket", 24000],
  ["Ravi Menon", "Espresso machine", 189900],
  ["Mei Tanaka", "Mechanical keyboard", 13900],
  ["Oscar Lindgren", "Wool blanket", 6400],
  ["Sofia Alvarez", "Standing desk", 245000],
  ["Kwame Mensah", "Noise-cancelling headphones", 34900],
];
const view = (r: any): Order => ({
  orderId: r.id,
  customer: r.customer,
  item: r.item,
  amountMinor: r.amount_minor,
  refundedMinor: r.refunded_minor,
  currency: r.currency,
});

export async function createOrder(
  db: Db,
  tenantId: string,
  sandboxId: string,
  o: { customer: string; item: string; amountMinor: number },
  now = Date.now(),
): Promise<Order> {
  const n = await db.query(
    "select count(*)::int n from policy_desk.orders where tenant_id=$1",
    [tenantId],
  );
  if (n.rows[0].n >= MAX_ORDERS_PER_GENERATION) throw new OrderLimit();
  const id = `ord_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const r = await db.query(
    "insert into policy_desk.orders (id,tenant_id,sandbox_id,customer,item,amount_minor,created_at) values ($1,$2,$3,$4,$5,$6,$7) returning *",
    [
      id,
      tenantId,
      sandboxId,
      o.customer,
      o.item,
      o.amountMinor,
      new Date(now).toISOString(),
    ],
  );
  return view(r.rows[0]);
}
export class OrderLimit extends Error {}

export async function seedOrders(db: Db, tenantId: string, sandboxId: string) {
  const out: Order[] = [];
  for (const [customer, item, amountMinor] of SAMPLES)
    out.push(
      await createOrder(db, tenantId, sandboxId, {
        customer,
        item,
        amountMinor,
      }),
    );
  return out;
}
export async function listOrders(db: Db, tenantId: string): Promise<Order[]> {
  const r = await db.query(
    "select * from policy_desk.orders where tenant_id=$1 order by created_at, id",
    [tenantId],
  );
  return r.rows.map(view);
}
export async function getOrder(
  db: Db,
  tenantId: string,
  orderId: string,
): Promise<Order | null> {
  const r = await db.query(
    "select * from policy_desk.orders where tenant_id=$1 and id=$2",
    [tenantId, orderId],
  );
  return r.rows[0] ? view(r.rows[0]) : null;
}

/** Provider call. Idempotent on the operation key; only reachable from an authorized claim. */
export async function simulateRefund(
  conn: { query: Db["query"] },
  tenantId: string,
  o: {
    orderId: string;
    amountMinor: number;
    idempotencyKey: string;
    claimId: string;
  },
) {
  const prior = await conn.query(
    "select * from policy_desk.refunds where idempotency_key=$1 and tenant_id=$2",
    [o.idempotencyKey, tenantId],
  );
  if (prior.rows[0])
    return {
      refundId: prior.rows[0].refund_id as string,
      status: "succeeded" as const,
      amountMinor: prior.rows[0].amount_minor as number,
    };
  await conn.query("begin");
  try {
    const p = (
      await conn.query(
        "select amount_minor, refunded_minor from policy_desk.orders where id=$1 and tenant_id=$2 for update",
        [o.orderId, tenantId],
      )
    ).rows[0];
    if (!p || o.amountMinor > p.amount_minor - p.refunded_minor)
      throw new Error("amount_exceeds_refundable_balance");
    const refundId = `re_sim_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await conn.query(
      "insert into policy_desk.refunds (refund_id,order_id,tenant_id,idempotency_key,claim_id,amount_minor,status,created_at) values ($1,$2,$3,$4,$5,$6,'succeeded',now())",
      [
        refundId,
        o.orderId,
        tenantId,
        o.idempotencyKey,
        o.claimId,
        o.amountMinor,
      ],
    );
    await conn.query(
      "update policy_desk.orders set refunded_minor = refunded_minor + $2 where id=$1",
      [o.orderId, o.amountMinor],
    );
    await conn.query("commit");
    return {
      refundId,
      status: "succeeded" as const,
      amountMinor: o.amountMinor,
    };
  } catch (e) {
    await conn.query("rollback").catch(() => undefined);
    throw e;
  }
}
