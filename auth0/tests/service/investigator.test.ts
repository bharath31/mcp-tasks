import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  CLIENTS,
  ORG,
  PEOPLE,
  createWorld,
  type World,
} from "../helpers/world.js";

let w: World;
before(async () => {
  w = await createWorld({ secondTenant: true });
});
after(async () => w.close());

/** One complete exception flow; returns its ids. */
async function flow(amountMinor = 15000) {
  const d = (await w.delegate()).json;
  const op = (await w.register(d.id, { amountMinor })).json;
  const ap = (await w.requestApproval(op.id)).json;
  await w.approve(ap.id, op.digest);
  const claim = (await w.claim(op)).json;
  await w.outcome(op.id, claim.claimId, "succeeded", "re_1");
  return { d, op, ap, claim };
}
const query = async (qs: string, token?: string) =>
  w.call("GET", `/v1/audit${qs}`, {
    token: token ?? (await w.tok.investigator()),
  });

describe("investigator audit query (FR-030)", () => {
  test("filter by correlation id returns exactly one chain, in order, linked to real records", async () => {
    const a = await flow();
    const b = await flow(16000);
    const r = await query(`?correlationId=${a.op.correlationId}`);
    assert.equal(r.status, 200);
    const types = r.json.events.map((e: { type: string }) => e.type);
    assert.deepEqual(types, [
      "delegation.created",
      "operation.registered",
      "approval.requested",
      "approval.approved",
      "authorization.allowed",
      "claim.created",
      "outcome.reported",
    ]);
    assert.ok(
      r.json.events.every(
        (e: { correlationId: string }) =>
          e.correlationId === a.op.correlationId,
      ),
    );
    assert.ok(
      !r.json.events.some(
        (e: { operationId: string | null }) => e.operationId === b.op.id,
      ),
    );
    const ids = r.json.events.map((e: { id: string }) => Number(e.id));
    assert.deepEqual(
      ids,
      [...ids].sort((x, y) => x - y),
    );
    assert.equal(
      r.json.events.find((e: { type: string }) => e.type === "claim.created")
        .claimId,
      a.claim.claimId,
    );
  });

  test("filters by operation, delegation, type and reason compose; pagination is stable", async () => {
    const f = await flow();
    const byOp = await query(`?operationId=${f.op.id}`);
    assert.ok(byOp.json.events.length >= 6);
    assert.equal(
      (await query(`?delegationId=${f.d.id}&type=claim.created`)).json.events
        .length,
      1,
    );
    const denied = await w.claim(f.op); // reconcile_required is data, not an event type filter hit
    void denied;
    const d2 = (await w.delegate()).json;
    const op2 = (await w.register(d2.id, { amountMinor: 15000 })).json;
    await w.claim(op2); // approval_required -> denial audited
    const reason = await query(
      `?operationId=${op2.id}&reason=approval_required`,
    );
    assert.equal(reason.json.events.length, 1);
    assert.equal(reason.json.events[0].decision, "deny");

    const page1 = await query(`?correlationId=${f.op.correlationId}&limit=3`);
    assert.equal(page1.json.events.length, 3);
    assert.ok(page1.json.next);
    const page2 = await query(
      `?correlationId=${f.op.correlationId}&limit=50&after=${page1.json.next}`,
    );
    const all = await query(`?correlationId=${f.op.correlationId}&limit=50`);
    assert.deepEqual(
      [...page1.json.events, ...page2.json.events].map(
        (e: { id: string }) => e.id,
      ),
      all.json.events.map((e: { id: string }) => e.id),
    );
    assert.equal(page2.json.next, null);
  });

  test("input is validated: bad limits, cursors and filter values are invalid_request", async () => {
    for (const qs of [
      "?limit=0",
      "?limit=500",
      "?limit=abc",
      "?after=x",
      "?correlationId=bad value!",
      "?type=a%20b",
    ])
      assert.equal((await query(qs)).json.code, "invalid_request", qs);
  });

  test("RBAC: audit:read for services; FGA investigator for humans, limited to their organization; everyone else gets nothing", async () => {
    const f = await flow();
    assert.equal(
      (await query("", await w.tok.api())).json.code,
      "not_authorized",
      "a backend without audit:read",
    );
    assert.equal(
      (await query("", await w.tok.executor())).json.code,
      "not_authorized",
    );
    const inspector = await query(
      `?operationId=${f.op.id}`,
      await w.tok.user(PEOPLE.inspector, ORG.northstar),
    );
    assert.equal(inspector.status, 200);
    assert.ok(inspector.json.events.length >= 6);
    for (const [p, o] of [
      [PEOPLE.alice, ORG.northstar],
      [PEOPLE.morgan, ORG.northstar],
      [PEOPLE.mallory, ORG.southridge],
    ] as const)
      assert.equal(
        (await query(`?operationId=${f.op.id}`, await w.tok.user(p, o))).json
          .code,
        "not_found",
        p,
      );
    // An investigator token scoped to another organization sees none of Northstar's events.
    await w.fga.write([
      {
        user: `user:${PEOPLE.mallory}`,
        relation: "investigator",
        object: `organization:${ORG.southridge}`,
      },
    ]);
    try {
      const other = await query(
        `?operationId=${f.op.id}`,
        await w.tok.user(PEOPLE.mallory, ORG.southridge),
      );
      assert.equal(other.status, 200);
      assert.equal(other.json.events.length, 0);
    } finally {
      await w.fga.delete([
        {
          user: `user:${PEOPLE.mallory}`,
          relation: "investigator",
          object: `organization:${ORG.southridge}`,
        },
      ]);
    }
  });

  test("tenant isolation: another tenant's investigator sees nothing", async () => {
    const f = await flow();
    const foreign = await w.idp2!.service(CLIENTS.investigator, ["audit:read"]);
    const r = await query(`?correlationId=${f.op.correlationId}`, foreign);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.events, []);
  });

  test("audit rows never carry secrets or addresses (checked over the query output)", async () => {
    const all = JSON.stringify((await query("?limit=200")).json);
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(all));
    assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(all.replaceAll("@clients", "")));
  });
});

describe("usage counters (FR-008)", () => {
  test("every lifecycle step is counted per tenant per day, and quotas are reported", async () => {
    const before = (
      await w.call("GET", "/v1/usage", { token: await w.tok.investigator() })
    ).json.counters as Record<string, number>;
    await flow();
    const r = await w.call("GET", "/v1/usage", {
      token: await w.tok.investigator(),
    });
    assert.equal(r.status, 200);
    const after = r.json.counters as Record<string, number>;
    for (const m of [
      "delegations",
      "operations",
      "approvals",
      "decisions",
      "claims",
      "outcomes",
    ])
      assert.equal(after[m]! - (before[m] ?? 0), 1, m);
    assert.equal(r.json.tenantId, "tnt_demo");
    assert.equal(typeof r.json.quotas.claimsPerDay, "number");
    assert.match(r.json.note, /not billing/i);
  });
  test("usage is private to the tenant and needs usage:read", async () => {
    assert.equal(
      (await w.call("GET", "/v1/usage", { token: await w.tok.executor() })).json
        .code,
      "not_authorized",
    );
    const foreign = await w.idp2!.service(CLIENTS.investigator, ["usage:read"]);
    const r = await w.call("GET", "/v1/usage", { token: foreign });
    assert.equal(r.json.tenantId, "tnt_other");
    assert.deepEqual(r.json.counters, {});
    assert.equal(
      (
        await w.call("GET", "/v1/usage?day=nope", {
          token: await w.tok.investigator(),
        })
      ).json.code,
      "invalid_request",
    );
  });
  test("retried registrations are not double counted", async () => {
    const d = (await w.delegate()).json;
    const base =
      (await w.call("GET", "/v1/usage", { token: await w.tok.investigator() }))
        .json.counters.operations ?? 0;
    await w.register(d.id, {
      key: "usage:dup:1",
      amountMinor: 5000,
      assertion: "none",
    });
    await w.register(d.id, {
      key: "usage:dup:1",
      amountMinor: 5000,
      assertion: "none",
    });
    const now = (
      await w.call("GET", "/v1/usage", { token: await w.tok.investigator() })
    ).json.counters.operations;
    assert.equal(now - base, 1);
  });
});
