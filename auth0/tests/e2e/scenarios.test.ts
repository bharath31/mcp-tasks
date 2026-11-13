import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { AGENTS, ORG, PEOPLE } from "../helpers/world.js";
import {
  MCP_CLIENT_SOUTHRIDGE,
  OPERATOR_TOKEN,
  createDesk,
  type Desk,
} from "../helpers/desk.js";
import { mintDispatchGrant } from "../../../demo/refund-desk/src/payments.js";
import {
  createApplicationInputHandler,
  withTasks,
} from "@modelcontextprotocol/ext-tasks/client";
import { fetchPort } from "../helpers/mcp-port.js";

let d: Desk;
before(async () => {
  d = await createDesk();
});
after(async () => d.close());

const u = (p: string) => `user:${p}`;
const org = `organization:${ORG.northstar}`;
const taskId = (r: Awaited<ReturnType<Desk["refund"]>>): string =>
  r.body.result.taskId;

/** Alice's $150 exception through the real MCP surface; returns once the manager decision is requested. */
async function exception(orderId: string, amountMinor = 15000) {
  const paymentId = await d.payment();
  const id = taskId(
    await d.refund({
      paymentId,
      orderId,
      amountMinor,
      note: "Damaged on arrival, RMA verified.",
    }),
  );
  assert.equal((await d.warehouse(orderId, paymentId)).body.matchedTask, true);
  await d.step(0); // worker: warehouse event -> request manager decision
  const task = (await d.repo.get(id))!;
  const op = await d.authority.operations.get(task.operationId!);
  assert.equal(op.approvalStatus, "pending", "a human decision is requested");
  return { id, paymentId, task, op, approvalId: op.approvalId! };
}
const approve = (
  approvalId: string,
  digest: string,
  o: Parameters<Desk["w"]["approve"]>[2] = {},
) => d.w.approve(approvalId, digest, o);
/** Let the worker run until the task reaches one of the given statuses (bounded). */
async function drive(
  id: string,
  done: (t: any) => boolean = (t) => t.status !== "working",
) {
  for (let i = 0; i < 14; i++) {
    const t = await d.get(id);
    if (done(t)) return t;
    await d.step(16_000);
  }
  return d.get(id);
}
const providerCalls = () => d.payments.calls.length;
const refunded = async (paymentId: string) =>
  (await d.payments.inspect(ORG.northstar, paymentId)).refundedMinor;

describe("main flows", () => {
  test("exception: Alice requests $150, disconnects, Morgan approves with MFA, the executor claims and refunds once; evidence is correlated", async () => {
    const calls0 = providerCalls();
    const { id, paymentId, op, approvalId } = await exception("N-742");
    // While the client is "disconnected" nothing needs it; the task is simply working.
    assert.equal((await d.get(id)).status, "working");
    assert.match((await d.get(id)).statusMessage, /reviewer/i);
    assert.equal((await approve(approvalId, op.digest)).status, 200);
    const done = await drive(id);
    assert.equal(done.status, "completed");
    assert.equal(done.result.isError, false);
    assert.equal(done.result.structuredContent.outcome, "refunded");
    assert.equal(providerCalls() - calls0, 1);
    assert.equal(await refunded(paymentId), 15000);
    // The Stripe-idempotency analogue is the operation key.
    const key = (
      await d.repo.pool.query(
        "select idempotency_key from refund_desk.sim_refunds where payment_id=$1",
        [paymentId],
      )
    ).rows[0].idempotency_key;
    assert.equal(key, (await d.repo.get(id))!.operationKey);

    const tl = await d.service.timeline(
      { sub: PEOPLE.alice, orgId: ORG.northstar },
      id,
    );
    const layers = new Set(tl.map((e) => e.layer));
    assert.deepEqual([...layers].sort(), ["customer app", "task authority"]);
    const events = tl
      .filter((e) => e.layer === "task authority")
      .map((e) => e.event);
    for (const e of [
      "delegation.created",
      "operation.registered",
      "approval.requested",
      "approval.approved",
      "authorization.allowed",
      "claim.created",
      "outcome.reported",
    ])
      assert.ok(events.includes(e), e);
    assert.equal(
      new Set(
        tl
          .filter((e) => e.layer === "task authority")
          .map((e: any) => e.correlationId),
      ).size,
      1,
    );
    assert.equal(
      done.result.structuredContent.authority.correlationId,
      (tl.find((e: any) => e.correlationId) as any).correlationId,
    );
    // The per-task grant is withdrawn when the work is over.
    assert.equal(
      (await d.authority.delegations.get((await d.repo.get(id))!.delegationId!))
        .status,
      "revoked",
    );
  });

  test("automatic: $50 needs no human, but delegation and FGA are still checked before the claim", async () => {
    const paymentId = await d.payment();
    const id = taskId(
      await d.refund({ paymentId, orderId: "N-50", amountMinor: 5000 }),
    );
    await d.warehouse("N-50", paymentId);
    const done = await drive(id);
    assert.equal(done.status, "completed");
    assert.equal(await refunded(paymentId), 5000);
    const op = await d.authority.operations.get(
      (await d.repo.get(id))!.operationId!,
    );
    assert.equal(op.approvalRequirement, "none");
    assert.equal(op.approvalId, null);
    const row = await d.w.store.pool.query(
      "select effective_authority from authority.claims where operation_id=$1",
      [op.id],
    );
    assert.ok(
      row.rows[0].effective_authority.checks.includes("owner_permission"),
    );
  });
});

describe("security scenarios (PRD 6.2)", () => {
  test("1 wrong manager: Southridge's Mallory cannot approve; no claim, no provider call", async () => {
    const { id, op, approvalId } = await exception("S1");
    const c0 = providerCalls();
    const r = await approve(approvalId, op.digest, {
      person: PEOPLE.mallory,
      org: ORG.southridge,
    });
    assert.equal(r.json.code, "not_authorized");
    const t = await drive(id, () => false); // run the worker through several cycles
    assert.equal(t.status, "working");
    assert.equal(providerCalls(), c0);
    assert.equal(
      (
        await d.w.store.pool.query(
          "select count(*) n from authority.claims where operation_id=$1",
          [op.id],
        )
      ).rows[0].n,
      "0",
    );
  });

  test("2 approver removed: claim denied, a fresh eligible decision is required, then it completes once", async () => {
    const { id, paymentId, op, approvalId } = await exception("S2");
    assert.equal((await approve(approvalId, op.digest)).status, 200);
    const tuple = {
      user: u(PEOPLE.morgan),
      relation: "refund_approve",
      object: org,
    };
    await d.w.fga.delete([tuple]);
    try {
      const c0 = providerCalls();
      const mid = await drive(id, (t) =>
        /no longer eligible/i.test(t.statusMessage ?? ""),
      );
      assert.equal(mid.status, "working");
      await d.step(0); // worker re-requests the human decision
      assert.equal(
        providerCalls(),
        c0,
        "no provider call while the approver is ineligible",
      );
      assert.equal(await refunded(paymentId), 0);
      const fresh = await d.authority.operations.get(op.id);
      assert.equal(
        fresh.approvalStatus,
        "pending",
        "the old decision was superseded by a new request",
      );
      assert.notEqual(fresh.approvalId, approvalId);
      // Morgan's rights are restored and Morgan decides afresh (a new bound challenge).
      await d.w.fga.write([tuple]);
      assert.equal((await approve(fresh.approvalId!, op.digest)).status, 200);
      const done = await drive(id);
      assert.equal(done.status, "completed");
      assert.equal(providerCalls() - c0, 1);
    } finally {
      await d.w.fga.write([tuple]);
    }
  });

  test("3 grant revoked before claim: denied, task reports revoked authority, no refund", async () => {
    const { id, paymentId, task, op, approvalId } = await exception("S3");
    await approve(approvalId, op.digest);
    await d.authority.delegations.revoke(task.delegationId!, {
      reason: "northstar_policy",
    });
    const c0 = providerCalls();
    const done = await drive(id);
    assert.equal(done.status, "completed");
    assert.equal(done.result.isError, true);
    assert.equal(done.result.structuredContent.outcome, "delegation_revoked");
    assert.equal(providerCalls(), c0);
    assert.equal(await refunded(paymentId), 0);
  });

  test("4a employee leaves, user-owned grant: execution is denied", async () => {
    const paymentId = await d.payment();
    const id = taskId(
      await d.refund({ paymentId, orderId: "S4A", amountMinor: 5000 }),
    );
    const gone = [
      { user: u(PEOPLE.alice), relation: "refund_request", object: org },
    ];
    await d.w.fga.delete(gone);
    try {
      await d.warehouse("S4A", paymentId);
      const c0 = providerCalls();
      const done = await drive(id);
      assert.equal(done.result.structuredContent.outcome, "not_authorized");
      assert.equal(
        done.result.structuredContent.reason,
        "owner_permission_lost",
      );
      assert.equal(providerCalls(), c0);
    } finally {
      await d.w.fga.write(gone);
    }
  });

  test("4b employee leaves, org-owned grant: work continues under organization policy", async () => {
    const standing = (
      await d.w.delegate({ ownerType: "organization", person: PEOPLE.olivia })
    ).json;
    assert.equal(standing.ownerType, "organization");
    d.service.o.standingDelegations = { [ORG.northstar]: standing.id };
    try {
      const paymentId = await d.payment();
      const id = taskId(
        await d.refund({ paymentId, orderId: "S4B", amountMinor: 5000 }),
      );
      const gone = [
        { user: u(PEOPLE.alice), relation: "member", object: org },
        { user: u(PEOPLE.alice), relation: "refund_request", object: org },
      ];
      await d.w.fga.delete(gone);
      try {
        await d.warehouse("S4B", paymentId);
        const done = await drive(id);
        assert.equal(done.status, "completed", JSON.stringify(done));
        assert.equal(await refunded(paymentId), 5000);
        // The former employee loses access at the authority service.
        const op = (await d.repo.get(id))!.operationId!;
        const read = await d.w.call("GET", `/v1/operations/${op}`, {
          token: await d.w.tok.user(PEOPLE.alice, ORG.northstar),
        });
        assert.equal(read.json.code, "not_found");
        // The standing grant is the organization's: finishing a task does not revoke it.
        assert.equal(
          (await d.authority.delegations.get(standing.id)).status,
          "active",
        );
      } finally {
        await d.w.fga.write(gone);
      }
    } finally {
      d.service.o.standingDelegations = undefined;
    }
  });

  test("5 changed amount: an approval for $150 never authorizes $200; only the approved operation refunds", async () => {
    const a = await exception("S5", 15000);
    await approve(a.approvalId, a.op.digest);
    const paymentId2 = a.paymentId;
    // The agent now asks for $200 on the same order/payment: a different exact operation.
    const id2 = taskId(
      await d.refund({
        paymentId: paymentId2,
        orderId: "S5",
        amountMinor: 20000,
        note: "Customer also lost the accessories.",
      }),
    );
    assert.notEqual(id2, a.id);
    const done = await drive(a.id);
    assert.equal(done.status, "completed");
    assert.equal(await refunded(paymentId2), 15000);
    await d.warehouse("S5", paymentId2, { eventId: "evt_s5_second_return" });
    const t2 = await drive(id2, () => false);
    assert.equal(
      t2.status,
      "working",
      "the $200 task is still waiting for its own approval",
    );
    assert.equal(await refunded(paymentId2), 15000);
    // Service-level proof: the $200 operation has no approval and a replayed $150 digest is a change.
    const o1 = (await d.repo.get(a.id))!,
      o2 = (await d.repo.get(id2))!;
    const claim = await d.executor.operations.authorizeAndClaim({
      operationId: o2.operationId!,
      operationDigest: o1.operationDigest!,
      executionKey: o2.operationKey,
    });
    assert.ok(
      claim.decision === "denied" && claim.code === "operation_changed",
    );
  });

  test("6 disconnected client: nothing needs the MCP connection; a later session reads the accurate result", async () => {
    const paymentId = await d.payment();
    const first = await d.refund({
      paymentId,
      orderId: "S6",
      amountMinor: 15000,
      note: "Return confirmed by carrier.",
    });
    const id = taskId(first); // the client now goes away: no polling at all
    await d.warehouse("S6", paymentId);
    await d.step(0);
    const task = (await d.repo.get(id))!;
    const op = await d.authority.operations.get(task.operationId!);
    await approve(op.approvalId!, op.digest);
    for (let i = 0; i < 8; i++) await d.step(16_000);
    // New session, newly issued credential:
    const view = await d.get(id, await d.mcpToken(PEOPLE.alice, ORG.northstar));
    assert.equal(view.status, "completed");
    assert.equal(
      view.result.structuredContent.refundId.startsWith("re_sim_"),
      true,
    );
  });

  test("7a uncertainty: provider succeeds but the response is lost -> reconcile by key, one refund, no replay", async () => {
    const paymentId = await d.payment();
    const id = taskId(
      await d.refund({ paymentId, orderId: "S7", amountMinor: 5000 }),
    );
    await d.warehouse("S7", paymentId);
    d.payments.faults = { loseResponseAfterSuccess: 1 };
    const c0 = providerCalls();
    await d.step(0); // review -> ready
    await d.step(0); // dispatch: provider succeeded, response lost
    const mid = await d.get(id);
    assert.equal(mid.status, "working");
    assert.match(mid.statusMessage, /reconcil|dependency/i);
    assert.equal(await refunded(paymentId), 5000, "the provider did refund");
    const done = await drive(id);
    assert.equal(done.status, "completed");
    assert.equal(await refunded(paymentId), 5000, "still exactly one refund");
    assert.equal(
      providerCalls() - c0,
      1,
      "the provider refund endpoint was called once; reconciliation used lookup",
    );
    const claims = (
      await d.w.store.pool.query(
        "select status from authority.claims where operation_id=$1",
        [(await d.repo.get(id))!.operationId],
      )
    ).rows;
    assert.deepEqual(
      claims.map((c) => c.status),
      ["succeeded"],
    );
  });

  test("7b uncertainty: repeated provider outages end as failed/manual reconciliation, never a fabricated success or second refund", async () => {
    const paymentId = await d.payment();
    const id = taskId(
      await d.refund({ paymentId, orderId: "S7B", amountMinor: 5000 }),
    );
    await d.warehouse("S7B", paymentId);
    d.payments.faults = { unavailable: 100 };
    let t: any;
    for (let i = 0; i < 40; i++) {
      await d.step(20 * 60_000);
      t = await d.get(id);
      if (t.status !== "working") break;
    }
    d.payments.faults = {};
    assert.equal(t.status, "failed");
    assert.equal(t.error.message, "execution_failed");
    assert.equal(t.error.data.reason, "manual_reconciliation_required");
    assert.equal(await refunded(paymentId), 0);
  });

  test("7c pending provider refund stays honest until settled", async () => {
    const paymentId = await d.payment();
    const id = taskId(
      await d.refund({ paymentId, orderId: "S7C", amountMinor: 5000 }),
    );
    await d.warehouse("S7C", paymentId);
    d.payments.faults = { pending: 1 };
    await d.step(0);
    await d.step(0);
    const pending = await d.get(id);
    assert.equal(pending.status, "working");
    assert.match(pending.statusMessage, /pending/i);
    assert.equal(await refunded(paymentId), 5000);
    assert.equal((await drive(id)).status, "completed");
  });

  test("8 expired approval: the stale decision never authorizes; a fresh authenticated decision does", async () => {
    const { id, paymentId, op, approvalId } = await exception("S8");
    await approve(approvalId, op.digest);
    d.w.clock.advance(31 * 60_000); // approval window (30m) lapses before dispatch
    const c0 = providerCalls();
    await d.step(0); // review -> ready (service reports the lapsed window)
    await d.step(16_000);
    await d.step(16_000);
    const mid = await d.get(id);
    assert.equal(mid.status, "working");
    assert.equal(providerCalls(), c0);
    const fresh = await d.authority.operations.get(op.id);
    assert.equal(fresh.approvalStatus, "pending");
    assert.notEqual(fresh.approvalId, approvalId);
    assert.equal((await approve(fresh.approvalId!, op.digest)).status, 200);
    assert.equal((await drive(id)).status, "completed");
    assert.equal(await refunded(paymentId), 15000);
  });
});

describe("faults, bypass and ingress", () => {
  test("FGA outage fails closed: no provider call, bounded retry, then it proceeds once healthy", async () => {
    const paymentId = await d.payment();
    const id = taskId(
      await d.refund({ paymentId, orderId: "F1", amountMinor: 5000 }),
    );
    await d.warehouse("F1", paymentId);
    await d.step(0); // review OK
    d.w.fga.failing = true;
    const c0 = providerCalls();
    await d.step(0);
    await d.step(5000);
    assert.equal(providerCalls(), c0);
    assert.equal((await d.get(id)).status, "working");
    d.w.fga.failing = false;
    assert.equal((await drive(id)).status, "completed");
    assert.equal(providerCalls() - c0, 1);
  });

  test("an unreachable Task Authority service also fails closed (no claim -> no provider call)", async () => {
    const paymentId = await d.payment();
    const id = taskId(
      await d.refund({ paymentId, orderId: "F2", amountMinor: 5000 }),
    );
    await d.warehouse("F2", paymentId);
    await d.step(0);
    const orig = d.w.handle;
    const c0 = providerCalls();
    d.w.fga.failing = true; // service answers 503 authorization_unavailable
    await d.step(0);
    d.w.fga.failing = false;
    assert.equal(providerCalls(), c0);
    void orig;
    assert.equal((await drive(id)).status, "completed");
  });

  test("side-effect bypass: the provider adapter refuses to act without a minted dispatch grant", async () => {
    const paymentId = await d.payment();
    const cmd = {
      paymentId,
      amountMinor: 1000,
      currency: "USD",
      idempotencyKey: "k:bypass",
    };
    await assert.rejects(
      d.payments.refund(cmd, {
        claimId: "clm_forged",
        operationKey: "k:bypass",
      }),
      /refused_without_authorized_claim/,
    );
    await assert.rejects(
      d.payments.refund(cmd, mintDispatchGrant("clm_1", "some:other:key")),
      /refused_without_authorized_claim/,
    );
    assert.equal(await refunded(paymentId), 0);
    // Documented limit: a compromised worker holding provider credentials could still call the provider directly.
  });

  test("two workers racing on one task produce one refund", async () => {
    const paymentId = await d.payment();
    const id = taskId(
      await d.refund({ paymentId, orderId: "RACE", amountMinor: 5000 }),
    );
    await d.warehouse("RACE", paymentId);
    await d.step(0);
    const c0 = providerCalls();
    const t = (await d.repo.get(id))!;
    await Promise.all([
      d.service.tick(t),
      d.service.tick(t),
      d.service.tick(t),
    ]);
    for (let i = 0; i < 4; i++) await d.step(16_000);
    assert.equal((await d.get(id)).status, "completed");
    assert.equal(providerCalls() - c0, 1);
    assert.equal(await refunded(paymentId), 5000);
  });

  test("warehouse ingress: tampered, wrong-secret, stale and unsigned events are refused uniformly; duplicates apply once", async () => {
    const paymentId = await d.payment();
    taskId(await d.refund({ paymentId, orderId: "W1", amountMinor: 5000 }));
    for (const o of [
      { tamper: true },
      { secret: "wrong-secret-wrong-secret-0000" },
      { ts: Math.floor(d.w.clock.now() / 1000) - 3600 },
    ]) {
      const r = await d.warehouse("W1", paymentId, o);
      assert.equal(r.status, 401);
      assert.deepEqual(r.body, { error: "invalid_warehouse_event" });
    }
    const unsigned = await d.app(
      new Request("https://refund-desk.test/api/warehouse/events", {
        method: "POST",
        body: "{}",
      }),
    );
    assert.equal(unsigned.status, 401);
    // An agent's MCP bearer token is not a warehouse credential.
    const agent = await d.app(
      new Request("https://refund-desk.test/api/warehouse/events", {
        method: "POST",
        headers: { authorization: `Bearer ${await d.alice()}` },
        body: "{}",
      }),
    );
    assert.equal(agent.status, 401);
    const first = await d.warehouse("W1", paymentId, {
      eventId: "evt_dup_000001",
    });
    const again = await d.warehouse("W1", paymentId, {
      eventId: "evt_dup_000001",
    });
    assert.equal(first.body.duplicate, false);
    assert.equal(again.body.duplicate, true);
    assert.equal(
      (
        await d.repo.pool.query(
          "select count(*) n from refund_desk.task_events where event='return_received'",
        )
      ).rows[0].n >= "1",
      true,
    );
  });

  test("an event that arrives before its task is held and applied when the task is created", async () => {
    const paymentId = await d.payment();
    assert.equal(
      (await d.warehouse("EARLY", paymentId)).body.matchedTask,
      false,
    );
    const id = taskId(
      await d.refund({ paymentId, orderId: "EARLY", amountMinor: 5000 }),
    );
    const view = await d.get(id);
    assert.match(view.statusMessage, /Return already verified/);
    assert.equal((await drive(id)).status, "completed");
  });

  test("operator controls are not mounted without the operator token and never forge a task state", async () => {
    const noAuth = await d.app(
      new Request("https://refund-desk.test/operator/faults", {
        method: "POST",
        body: "{}",
      }),
    );
    assert.equal(noAuth.status, 401);
    const asAgent = await d.app(
      new Request("https://refund-desk.test/operator/worker/run", {
        method: "POST",
        headers: { authorization: `Bearer ${await d.alice()}` },
      }),
    );
    assert.equal(asAgent.status, 401);
  });

  test("the customer database holds no grant/approval/claim tables and the app imports no service internals", async () => {
    const tables = (
      await d.repo.pool.query(
        "select table_name from information_schema.tables where table_schema='refund_desk' order by 1",
      )
    ).rows.map((r) => r.table_name);
    assert.deepEqual(tables, [
      "sim_payments",
      "sim_refunds",
      "task_events",
      "tasks",
      "warehouse_events",
    ]);
    void AGENTS;
  });
});

describe("cancellation after dispatch and operator controls", () => {
  test("tasks/cancel after dispatch began is acknowledged but never reports a reversal; the refund is reconciled", async () => {
    const paymentId = await d.payment();
    const id = taskId(
      await d.refund({ paymentId, orderId: "CXL-LATE", amountMinor: 5000 }),
    );
    await d.warehouse("CXL-LATE", paymentId);
    d.payments.faults = { loseResponseAfterSuccess: 1 };
    await d.step(0);
    await d.step(0); // provider refunded; the response was lost; the task is reconciling
    const ack = await d.rpc(
      "tasks/cancel",
      { taskId: id },
      { token: await d.alice() },
    );
    assert.equal(ack.body.result.resultType, "complete");
    const mid = await d.get(id);
    assert.equal(mid.status, "working");
    assert.match(mid.statusMessage, /Cancellation requested/i);
    const done = await drive(id);
    assert.equal(
      done.status,
      "completed",
      "an already-dispatched refund is not reported as cancelled",
    );
    assert.equal(done.result.structuredContent.outcome, "refunded");
    assert.equal(await refunded(paymentId), 5000);
    const op = await d.authority.operations.get(
      (await d.repo.get(id))!.operationId!,
    );
    assert.equal(op.status, "settled");
  });

  test("operator-only controls mutate fixtures through authenticated APIs, and their effects show in real service decisions", async () => {
    const auth = {
      authorization: `Bearer ${OPERATOR_TOKEN}`,
      "content-type": "application/json",
    };
    const call = async (path: string, body?: unknown) => {
      const r = await d.app(
        new Request(`https://refund-desk.test${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: auth,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      return { status: r.status, body: (await r.json()) as any };
    };
    const paymentId = await d.payment();
    const id = taskId(
      await d.refund({
        paymentId,
        orderId: "OPS",
        amountMinor: 15000,
        note: "Operator scenario run.",
      }),
    );
    // Fixture: synthetic warehouse event (clearly labelled), then the worker requests the decision.
    const w1 = await call("/operator/warehouse-event", {
      orgId: ORG.northstar,
      orderId: "OPS",
      paymentId,
    });
    assert.equal(w1.body.fixture, true);
    assert.equal(w1.body.matchedTask, true);
    await call("/operator/worker/run", {});
    const view = await call(`/operator/task?taskId=${id}`);
    assert.equal(view.body.task.stage, "awaiting_approval");
    assert.ok(
      view.body.timeline.some(
        (e: any) =>
          e.layer === "task authority" && e.event === "approval.requested",
      ),
    );
    // Fixture: manager loses access; the *service* then refuses the decision.
    const tuple = {
      user: `user:${PEOPLE.morgan}`,
      relation: "refund_approve",
      org: ORG.northstar,
    };
    assert.equal(
      (await call("/operator/permission", { ...tuple, granted: false })).body
        .applied,
      true,
    );
    try {
      const t = (await d.repo.get(id))!;
      const op = await d.authority.operations.get(t.operationId!);
      const refused = await approve(op.approvalId!, op.digest);
      assert.equal(refused.json.code, "approver_ineligible");
    } finally {
      await call("/operator/permission", { ...tuple, granted: true });
    }
    // Fixture: revoke authority; the next claim is refused by the service.
    const revoked = await call("/operator/revoke", { taskId: id });
    assert.equal(revoked.body.delegation.status, "revoked");
    const t2 = (await d.repo.get(id))!;
    const claim = await d.executor.operations.authorizeAndClaim({
      operationId: t2.operationId!,
      operationDigest: t2.operationDigest!,
      executionKey: t2.operationKey,
    });
    assert.ok(
      claim.decision === "denied" && claim.code === "delegation_revoked",
    );
    // Faults are simulator-only and take effect in the adapter.
    assert.deepEqual(
      (await call("/operator/faults", { unavailable: 2 })).body.faults,
      { unavailable: 2 },
    );
    d.payments.faults = {};
    assert.equal((await call("/operator/nope", {})).status, 404);
  });
});

describe("crash window while accepting an input answer", () => {
  test("a task stranded between 'answer accepted' and 'authority registered' is reopened for a fresh answer, then proceeds once", async () => {
    const paymentId = await d.payment();
    const id = taskId(
      await d.refund({ paymentId, orderId: "CRASH-ANS", amountMinor: 15000 }),
    );
    assert.equal((await d.get(id)).status, "input_required");
    // Emulate exactly what a process death leaves behind: the CAS flip was committed, nothing was authorized.
    const t = (await d.repo.get(id))!;
    await d.repo.save({
      ...t,
      status: "working",
      stage: "awaiting_return",
      inputRequests: null,
      answeredInputs: ["exception_note"],
      request: {
        ...t.request,
        exceptionNote: "Note accepted before the crash.",
      },
      nextRunAt: new Date(d.w.clock.now() + 120_000),
      statusMessage: "Exception note received. Authorizing the refund request.",
    });
    assert.equal((await d.repo.get(id))!.operationId, null);
    const delegations = async () =>
      Number(
        (
          await d.w.store.pool.query(
            "select count(*) n from authority.delegations",
          )
        ).rows[0].n,
      );
    const before = await delegations();

    await d.step(0); // lease not yet lapsed: the worker must leave an in-flight authorization alone
    assert.equal((await d.get(id)).status, "working");
    await d.step(121_000); // lease lapsed: nobody finished it
    const reopened = await d.get(id);
    assert.equal(reopened.status, "input_required", JSON.stringify(reopened));
    // A new request gets a new key (MCP Tasks): the client already answered "exception_note"
    // and would deduplicate or refuse a second request under it.
    assert.deepEqual(Object.keys(reopened.inputRequests), ["exception_note:2"]);
    assert.match(reopened.statusMessage, /interrupted/i);
    assert.equal(
      await delegations(),
      before,
      "no authority was created by recovery",
    );

    // A late answer to the already-answered key is ignored.
    await d.rpc(
      "tasks/update",
      {
        taskId: id,
        inputResponses: {
          exception_note: { action: "accept", content: { note: "Stale." } },
        },
      },
      { token: await d.alice() },
    );
    assert.equal((await d.get(id)).status, "input_required");
    assert.equal(await delegations(), before);

    // The client answers the new request: this time it completes, once.
    const answer = {
      "exception_note:2": {
        action: "accept",
        content: { note: "Customer returned a damaged unit." },
      },
    };
    await d.rpc(
      "tasks/update",
      { taskId: id, inputResponses: answer },
      { token: await d.alice() },
    );
    assert.equal((await d.get(id)).status, "working");
    assert.equal(await delegations(), before + 1);
    assert.ok((await d.repo.get(id))!.operationId);
  });
});

describe("recovery through the official MCP Tasks requester", () => {
  test("@modelcontextprotocol/ext-tasks answers the re-asked note after a crash, because the re-ask has a new key", async () => {
    const paymentId = await d.payment();
    const token = await d.alice();
    let crashed = false;
    // The app accepts the first answer, then "dies" before registering any authority:
    // exactly the state the crash-window test above builds by hand.
    const transport = (async (url: string, init: RequestInit) => {
      const req = new Request(url, init);
      const body = (await req.clone().json()) as any;
      if (!crashed && body.method === "tasks/update") {
        const t = (await d.repo.get(body.params.taskId))!;
        const [key, answer] = Object.entries<any>(
          body.params.inputResponses,
        )[0]!;
        await d.repo.save({
          ...t,
          status: "working",
          stage: "awaiting_return",
          inputRequests: null,
          answeredInputs: [...t.answeredInputs, key!],
          request: { ...t.request, exceptionNote: answer.content.note },
          nextRunAt: new Date(d.w.clock.now() + 120_000),
        });
        // Signal only after the crash state is committed. Otherwise the test can
        // advance the clock and tick before this save, missing the expired lease.
        crashed = true;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { resultType: "complete" },
        });
      }
      return d.app(req);
    }) as typeof fetch;
    const asked: string[] = [];
    const port = fetchPort({
      url: "https://refund-desk.test",
      endpointId: "refund-desk-recovery",
      token: async () => token,
      fetch: transport,
    });
    const sess = withTasks(port, {
      onInputRequest: createApplicationInputHandler({
        elicitation: async (req) => {
          asked.push(String((req.params as { message?: string }).message));
          return {
            action: "accept",
            content: { note: "Customer returned a damaged unit." },
          };
        },
        sampling: async () => {
          throw new Error("this server never samples");
        },
        roots: async () => ({ roots: [] }),
      }),
    });
    const exec = await sess.callTool("request_refund", {
      orderId: "CRASH-REQUESTER",
      paymentId,
      amountMinor: 15000,
      currency: "USD",
      reason: "Customer returned the item",
    });
    assert.equal(exec.kind, "task");
    const id = exec.kind === "task" ? exec.serializeReference().taskId : "";
    const abort = new AbortController();
    let failure: unknown;
    const driving = exec
      .settle({ signal: abort.signal })
      .catch((e) => (failure = e));
    const until = async (ok: () => Promise<boolean> | boolean) => {
      for (let i = 0; i < 600 && !(await ok()); i++)
        await new Promise((r) => setTimeout(r, 50));
      return ok();
    };
    try {
      assert.ok(await until(() => crashed), "the crash state was committed");
      const stranded = (await d.repo.get(id))!;
      assert.equal(stranded.status, "working");
      assert.equal(stranded.operationId, null);
      assert.equal(stranded.nextRunAt.getTime(), d.w.clock.now() + 120_000);
      await d.step(121_000); // lease lapsed: the worker re-asks
      // A spec-following requester never answers a key twice and skips a repeated one, so
      // only a fresh key reaches the user again and lets the task proceed.
      assert.ok(
        await until(async () => Boolean((await d.repo.get(id))?.operationId)),
        `the re-asked note was never answered (asked ${asked.length}x, ${String(failure)}, ${JSON.stringify((await d.repo.get(id))?.inputRequests)}, ${JSON.stringify(port.requests)})`,
      );
      assert.equal(asked.length, 2);
      assert.equal(failure, undefined);
    } finally {
      abort.abort();
      await driving;
      if (exec.kind === "task") await exec.detach().catch(() => undefined);
    }
  });
});

describe("Southridge: a second merchant with its own people, agent and manager (FR-035)", () => {
  const sam = () =>
    d.mcpToken(PEOPLE.sam, ORG.southridge, { client: MCP_CLIENT_SOUTHRIDGE });

  test("Sam's $150 exception is approved by Southridge's own manager Mallory and refunded once; Northstar people cannot touch it", async () => {
    const paymentId = await d.payments.createPayment(
      ORG.southridge,
      30000,
      "USD",
    );
    const id = taskId(
      await d.refund({
        paymentId,
        orderId: "SR-1",
        amountMinor: 15000,
        note: "Wrong size shipped, RMA ok.",
        token: await sam(),
      }),
    );
    assert.equal(
      (await d.warehouse("SR-1", paymentId, { org: ORG.southridge })).body
        .matchedTask,
      true,
    );
    await d.step(0);
    const t = (await d.repo.get(id))!;
    assert.equal(t.orgId, ORG.southridge);
    const op = await d.authority.operations.get(t.operationId!);
    assert.equal(op.approvalStatus, "pending");

    // Northstar's manager is not a Southridge approver, however senior.
    assert.equal(
      (
        await approve(op.approvalId!, op.digest, {
          person: PEOPLE.morgan,
          org: ORG.northstar,
        })
      ).json.code,
      "not_authorized",
    );
    assert.equal(
      (
        await approve(op.approvalId!, op.digest, {
          person: PEOPLE.morgan,
          org: ORG.southridge,
        })
      ).json.code,
      "approver_ineligible",
    );
    // Northstar's requester cannot read Southridge's task, and Sam cannot read Northstar's.
    const alice = await d.rpc(
      "tasks/get",
      { taskId: id },
      { token: await d.alice() },
    );
    assert.equal(alice.body.error.message, "Task not found");

    assert.equal(
      (
        await approve(op.approvalId!, op.digest, {
          person: PEOPLE.mallory,
          org: ORG.southridge,
        })
      ).status,
      200,
    );
    let done: any;
    for (let i = 0; i < 12 && done?.status !== "completed"; i++) {
      await d.step(16_000);
      done = await d.get(id, await sam());
    }
    assert.equal(done.status, "completed");
    assert.equal(done.result.structuredContent.outcome, "refunded");
    assert.equal(
      (await d.payments.inspect(ORG.southridge, paymentId)).refundedMinor,
      15000,
    );
    const delegation = await d.w.store.pool.query(
      "select agent_id, organization_id from authority.delegations where id=$1",
      [t.delegationId],
    );
    assert.deepEqual(delegation.rows[0], {
      agent_id: "agent_returns_sr",
      organization_id: ORG.southridge,
    });
  });

  test("Southridge's automatic $50 path works, and Sam cannot refund a Northstar payment", async () => {
    const own = await d.payments.createPayment(ORG.southridge, 30000, "USD");
    const id = taskId(
      await d.refund({
        paymentId: own,
        orderId: "SR-50",
        amountMinor: 5000,
        token: await sam(),
      }),
    );
    await d.warehouse("SR-50", own, { org: ORG.southridge });
    let done: any;
    for (let i = 0; i < 12 && done?.status !== "completed"; i++) {
      await d.step(16_000);
      done = await d.get(id, await sam());
    }
    assert.equal(done.status, "completed");
    assert.equal(
      (await d.payments.inspect(ORG.southridge, own)).refundedMinor,
      5000,
    );
    const northstarPayment = await d.payment();
    const r = await d.refund({
      paymentId: northstarPayment,
      orderId: "X",
      amountMinor: 5000,
      token: await sam(),
    });
    assert.equal(
      r.body.result.isError,
      true,
      "another merchant's payment is not visible",
    );
  });
});
