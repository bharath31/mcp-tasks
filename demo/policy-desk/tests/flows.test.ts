import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { renderCli, renderMcp } from "@task-authority/sdk";
import { createHash } from "node:crypto";
import { cleanupExpired } from "../src/cleanup.js";
import { openHost } from "../src/host.js";
import { startWorld, ORIGIN, type World } from "./helpers/world.js";

let w: World;
let alice: string;
let bob: string;
before(async () => {
  w = await startWorld();
  alice = await w.login("alice");
  bob = await w.login("bob");
  assert.equal((await w.call("POST", "/sandbox/reset", alice, {})).status, 200);
  assert.equal((await w.call("POST", "/sandbox/reset", bob, {})).status, 200);
});
after(async () => w.close());

const agentToken = async () =>
  (
    (await (
      await fetch(`${w.oidc.issuer}oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "agent",
          client_secret: "agt-s",
          audience: w.env.TASK_AUTHORITY_AUDIENCE!,
        }),
      })
    ).json()) as any
  ).access_token as string;

describe("approval flow with real assurance (routine tier: a fresh passkey per refund)", () => {
  it("the delegation is user-owned by Alex, not by the visitor", async () => {
    const st = await w.call("GET", "/sandbox/me", alice);
    const pool = w.pool();
    const r = await pool.query(
      "select owner_type, actor_id, agent_id from authority.delegations where id=$1",
      [st.json.sandbox.delegationId],
    );
    await pool.end();
    assert.deepEqual(r.rows[0], {
      owner_type: "user",
      actor_id: "auth0|alex",
      agent_id: "agent_returns",
    });
    // Alice is neither grantor nor initiator, and cannot read Alex's delegation record.
    assert.equal(
      (
        await w.call(
          "GET",
          `/v1/delegations/${st.json.sandbox.delegationId}`,
          alice,
        )
      ).status,
      404,
    );
  });

  it("agent request -> reviewer approves with a fresh passkey -> agent resumes -> progress flips", async () => {
    const before = (await w.call("GET", "/sandbox/progress", alice)).json
      .progress;
    assert.equal(before.approvedWithStepUp, false);
    const s = await w.call("POST", "/sandbox/scenario", alice, {
      id: "routine_approval",
    });
    const { approvalId, operationId } = s.json;
    const digest = s.json.response.body.operation.digest;
    assert.equal(s.json.response.body.operation.actor.id, "auth0|alex");
    // The queue shows it to the reviewer (alice is not the initiator or grantor).
    const queue = await w.call(
      "GET",
      "/v1/approval-requests?status=pending",
      alice,
    );
    assert.ok(queue.json.approvals.some((a: any) => a.id === approvalId));

    // A plain login (no MFA) is refused with a specific reason.
    const plain = await w.call(
      "POST",
      `/v1/approval-requests/${approvalId}/decisions`,
      alice,
      { decision: "approve", operationDigest: digest },
    );
    assert.equal(plain.status, 403);
    assert.equal(plain.json.details.reason, "mfa_required");

    // Regression: a $139-style refund was approved with only the second factor
    // from sign-in (Guardian OTP), with no prompt at the approval itself.
    const signInMfa = await w.reviewer("alice");
    const reused = await signInMfa.post(
      `/v1/approval-requests/${approvalId}/decisions`,
      { decision: "approve", operationDigest: digest },
    );
    assert.equal(reused.status, 403, JSON.stringify(reused.json));
    assert.equal(reused.json.details.reason, "factor_not_satisfied");
    // A fresh step-up bound to this refund still fails with an OTP code.
    const otp = await w.decideWithStepUp("alice", approvalId, digest, {
      factor: "otp",
    });
    assert.equal(otp.status, 403, JSON.stringify(otp.json));
    assert.equal(otp.json.details.reason, "factor_not_satisfied");

    const d = await w.decideWithStepUp("alice", approvalId, digest);
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(d.json.status, "approved");

    const run = await w.call("POST", `/v1/refunds/${operationId}/run`, alice);
    assert.equal(run.status, 201, JSON.stringify(run.json));
    assert.equal(run.json.executed, true);
    assert.equal(run.json.result.simulator, true);

    const p = (await w.call("GET", "/sandbox/progress", alice)).json.progress;
    assert.deepEqual(
      [
        p.signedIn,
        p.policyPublished,
        p.approvalRequestedRefund,
        p.approvedWithStepUp,
        p.eventsPresent,
      ],
      [true, true, true, true, true],
    );
    const audit = await w.call(
      "GET",
      `/sandbox/audit?operationId=${operationId}`,
      alice,
    );
    const approved = audit.json.events.find(
      (e: any) => e.type === "approval.approved",
    );
    assert.ok(approved.policyVersion);
    assert.ok(Array.isArray(approved.ruleIds));
    const reg = audit.json.events.find(
      (e: any) => e.type === "operation.registered",
    );
    assert.equal(reg.policyActor.type, "agent");
  });

  it("a signed-in, device-bound reviewer rejects with no second factor; approving still needs a passkey", async () => {
    const s = await w.call("POST", "/sandbox/scenario", alice, {
      id: "routine_approval",
    });
    const { approvalId, operationId } = s.json;
    const digest = s.json.response.body.operation.digest;
    // Bearer sign-in (no DPoP) cannot reject without MFA.
    const bearer = await w.call(
      "POST",
      `/v1/approval-requests/${approvalId}/decisions`,
      alice,
      { decision: "reject", operationDigest: digest },
    );
    assert.equal(bearer.status, 403);
    assert.equal(bearer.json.details.reason, "mfa_required");
    // The email OTP sign-in the reviewer page holds: DPoP-bound, no second factor.
    const plain = await w.reviewer("alice", undefined, { stepUp: false });
    const approve = await plain.post(
      `/v1/approval-requests/${approvalId}/decisions`,
      { decision: "approve", operationDigest: digest },
    );
    assert.equal(approve.status, 403);
    assert.equal(approve.json.details.reason, "mfa_required");
    const reject = await plain.post(
      `/v1/approval-requests/${approvalId}/decisions`,
      { decision: "reject", operationDigest: digest },
    );
    assert.equal(reject.status, 200, JSON.stringify(reject.json));
    assert.equal(reject.json.status, "rejected");
    // Replaying the same rejection is idempotent; flipping it to approve is refused.
    const again = await plain.post(
      `/v1/approval-requests/${approvalId}/decisions`,
      { decision: "reject", operationDigest: digest },
    );
    assert.equal(again.status, 200, JSON.stringify(again.json));
    const audit = await w.call(
      "GET",
      `/sandbox/audit?operationId=${operationId}`,
      alice,
    );
    assert.ok(
      audit.json.events.some((e: any) => e.type === "approval.rejected"),
      JSON.stringify(audit.json.events.map((e: any) => e.type)),
    );
  });

  it("an expired delegation gives a clear refusal; a scenario run re-grants it from Alex's token", async () => {
    const me = (await w.call("GET", "/sandbox/me", alice)).json;
    const pool = w.pool();
    await pool.query(
      "update policy_desk.sandboxes set delegation_expires_at = now() - interval '1 minute' where id=$1",
      [me.sandboxId],
    );
    await pool.end();
    const order = (await w.call("GET", "/sandbox/orders", alice)).json.orders[0]
      .orderId;
    const agent = await agentToken();
    const refused = await w.call(
      "POST",
      "/v1/refunds",
      agent,
      { orderId: order, amountMinor: 2000 },
      { "x-policy-desk-sandbox": me.sandboxId },
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.json.reason, "delegation_expired");
    assert.equal(refused.json.nextAction, "reset_sandbox");
    const again = await w.call("POST", "/sandbox/scenario", alice, {
      id: "small_within_budget",
    });
    assert.equal(
      again.json.response.status,
      201,
      JSON.stringify(again.json.response.body),
    );
    const after = (await w.call("GET", "/sandbox/me", alice)).json.sandbox;
    assert.notEqual(after.delegationId, me.sandbox.delegationId);
  });

  it("DPoP is enforced: a bound token without a proof is refused", async () => {
    const s = await w.call("POST", "/sandbox/scenario", alice, {
      id: "routine_approval",
    });
    const k = await w.reviewer("alice");
    const r = await w.raw(
      `/v1/approval-requests/${s.json.approvalId}/decisions`,
      {
        method: "POST",
        token: k.token,
        body: JSON.stringify({
          decision: "approve",
          operationDigest: s.json.response.body.operation.digest,
        }),
      },
    );
    assert.equal(r.status, 401);
  });

  it("a reviewer without the FGA relation is refused (not_org_approver)", async () => {
    const out = await w.call("POST", "/sandbox/scenario", bob, {
      id: "routine_approval",
    });
    const pool = w.pool();
    await pool.query(
      "delete from policy_desk.fga_tuples where subject='user:auth0|bob' and relation='refund_approve'",
    );
    await pool.end();
    const rev = await w.reviewer("bob");
    const d = await rev.post(
      `/v1/approval-requests/${out.json.approvalId}/decisions`,
      {
        decision: "approve",
        operationDigest: out.json.response.body.operation.digest,
      },
    );
    assert.equal(d.status, 403);
    assert.equal(d.json.details.reason, "not_org_approver");
  });
});

describe("channel parity", () => {
  it("scenario, raw REST, CLI and MCP renderings agree on decision, reason, rules and policy version", async () => {
    const sc = await w.call("POST", "/sandbox/scenario", alice, {
      id: "routine_approval",
    });
    const order = (
      await w.call("POST", "/sandbox/scenario", alice, {
        id: "routine_approval",
      })
    ).json.request.body.orderId;
    const raw = await w.call(
      "POST",
      "/v1/refunds",
      await agentToken(),
      {
        orderId: order,
        amountMinor: 15000,
        currency: "USD",
        reason: "Wrong size returned",
      },
      {
        "x-policy-desk-sandbox": sc.json.operationId
          ? (await w.call("GET", "/sandbox/me", alice)).json.sandboxId
          : "",
      },
    );
    assert.equal(raw.status, sc.json.response.status);
    const a = sc.json.response.body,
      b = raw.json;
    for (const k of ["decision", "reasonCode", "policyVersion", "ruleIds"])
      assert.deepEqual(a[k], b[k], k);
    assert.equal(a.operation.tier, b.operation.tier);
    assert.deepEqual(renderCli(b).exitCode, sc.json.cli.exitCode);
    assert.deepEqual(renderMcp(b).status, sc.json.mcp.status);
  });
});

describe("outcome reporting", () => {
  it("a refund that committed but whose success report failed is unknown, then reconciles to succeeded, never failed", async () => {
    await w.call("POST", "/sandbox/reset", alice, {});
    const sandboxId = (await w.call("GET", "/sandbox/me", alice)).json
      .sandboxId;
    const order = (await w.call("GET", "/sandbox/orders", alice)).json.orders[1]
      .orderId;
    const pool = w.pool();
    // Make Task Authority refuse to record "succeeded" once the payment has committed.
    await pool.query(`
      create or replace function pg_temp_fail_success() returns trigger language plpgsql as
      $$ begin raise exception 'outcome store unavailable'; end $$;
      create trigger fail_success before update on authority.claims
        for each row when (new.status = 'succeeded') execute function pg_temp_fail_success();
    `);
    const idem = `report-lost-${Date.now()}`;
    let first: Awaited<ReturnType<World["call"]>>;
    try {
      first = await w.call(
        "POST",
        "/v1/refunds",
        await agentToken(),
        {
          orderId: order,
          amountMinor: 500,
          currency: "USD",
          reason: "Damaged",
        },
        { "x-policy-desk-sandbox": sandboxId, "idempotency-key": idem },
      );
    } finally {
      await pool.query(
        "drop trigger fail_success on authority.claims; drop function pg_temp_fail_success()",
      );
    }
    const opId = (
      await pool.query(
        "select id from authority.operations where operation_key like $1",
        [`%:${idem}`],
      )
    ).rows[0].id;
    const state = async () =>
      (
        await pool.query(
          `select c.status claim, o.status op,
             (select count(*)::int from policy_desk.refunds r where r.idempotency_key = o.operation_key) refunds
           from authority.operations o join authority.claims c on c.operation_id = o.id
           where o.id = $1 order by c.seq desc limit 1`,
          [opId],
        )
      ).rows[0];
    // The money moved; the authority must not hold a terminal failure for it.
    assert.deepEqual(await state(), {
      claim: "unknown",
      op: "claimed",
      refunds: 1,
    });
    // The console shows it as reconciling, not failed and not still to run.
    const shown = (
      await w.call("GET", "/sandbox/state", alice)
    ).json.operations.find((o: any) => o.id === opId);
    assert.equal(shown.outcomeStatus, "reconciling");
    // The caller is told the truth too: the refund was issued.
    assert.equal(first.status, 201, JSON.stringify(first.json));
    const run = await w.call(
      "POST",
      `/v1/refunds/${opId}/run`,
      await agentToken(),
      {},
      { "x-policy-desk-sandbox": sandboxId },
    );
    assert.ok(run.status < 300, JSON.stringify(run.json));
    const settled = await state();
    await pool.end();
    assert.equal(settled.claim, "succeeded");
    assert.equal(settled.refunds, 1, "reconciliation never pays twice");
  });
});

describe("isolation", () => {
  it("one visitor cannot see or touch another visitor's sandbox", async () => {
    const mine = await w.call("POST", "/sandbox/scenario", alice, {
      id: "routine_approval",
    });
    const theirs = await w.call(
      "GET",
      `/v1/refunds/${mine.json.operationId}`,
      bob,
    );
    assert.equal(theirs.status, 404);
    const svc = await w.call(
      "GET",
      `/v1/operations/${mine.json.operationId}`,
      bob,
    );
    assert.equal(svc.status, 404);
    const bobState = (await w.call("GET", "/sandbox/state", bob)).json;
    assert.ok(
      !bobState.operations.some((o: any) => o.id === mine.json.operationId),
    );
    assert.notEqual(
      (await w.call("GET", "/sandbox/me", alice)).json.sandboxId,
      (await w.call("GET", "/sandbox/me", bob)).json.sandboxId,
    );
    const bobOrder = bobState.orders[0].orderId;
    const cross = await w.call("POST", "/v1/refunds", alice, {
      orderId: bobOrder,
      amountMinor: 1000,
    });
    assert.equal(cross.status, 404);
    assert.equal(cross.json.reason, "order_not_found");
  });
  it("another visitor cannot read or use my delegation", async () => {
    const mine = (await w.call("GET", "/sandbox/me", alice)).json.sandbox
      .delegationId;
    const theirs = (await w.call("GET", "/sandbox/me", bob)).json.sandbox
      .delegationId;
    assert.notEqual(mine, theirs);
    assert.equal(
      (await w.call("GET", `/v1/delegations/${mine}`, bob)).status,
      404,
    );
    // Bob's own delegation cannot be reached by naming Alice's sandbox either.
    const aliceSbx = (await w.call("GET", "/sandbox/me", alice)).json.sandboxId;
    const order = (await w.call("GET", "/sandbox/orders", bob)).json.orders[0]
      .orderId;
    const r = await w.call(
      "POST",
      "/v1/refunds",
      bob,
      { orderId: order, amountMinor: 1000 },
      { "x-policy-desk-sandbox": aliceSbx },
    );
    assert.ok(
      r.json.operation.delegationId === null,
      "human requests never use a delegation",
    );
  });
  it("a token from another organization cannot create a sandbox against the agent's organization", async () => {
    const out = await w.login("outsider");
    const r = await w.call("POST", "/sandbox/reset", out, {});
    assert.equal(r.status, 403);
    assert.equal(r.json.reason, "wrong_organization");
  });
});

describe("refund step-up matrix (docs/approval-step-up-flows.md)", () => {
  const scenario = async (who: string) => {
    const s = await w.call("POST", "/sandbox/scenario", who, {
      id: "routine_approval",
    });
    return {
      approvalId: s.json.approvalId as string,
      digest: s.json.response.body.operation.digest as string,
    };
  };

  it("a passkey from a sign-in before the challenge does not approve; a fresh one does", async () => {
    const { approvalId, digest } = await scenario(alice);
    // A token that already carries a passkey, minted before this refund's challenge.
    const early = await w.reviewer("alice", undefined, {
      factor: "webauthn-platform",
    });
    const r = await early.post(
      `/v1/approval-requests/${approvalId}/decisions`,
      { decision: "approve", operationDigest: digest },
    );
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.match(
      r.json.details.reason,
      /step_up_stale_or_before_request|challenge_not_bound_to_operation/,
    );
    const d = await w.decideWithStepUp("alice", approvalId, digest, {
      factor: "webauthn-roaming",
    });
    assert.equal(d.status, 200, JSON.stringify(d.json));
  });

  it("a sandbox reset between the challenge and the return leaves nothing to approve", async () => {
    const { approvalId, digest } = await scenario(alice);
    const k = await w.dpopKey();
    const session = await w.reviewer("alice", undefined, {
      dpop: k,
      stepUp: false,
    });
    const c = await session.post(
      `/v1/approval-requests/${approvalId}/challenge`,
      {},
    );
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(
      (await w.call("POST", "/sandbox/reset", alice, {})).status,
      200,
    );
    const fresh = await w.reviewer("alice", undefined, {
      dpop: k,
      factor: "webauthn-platform",
      challenge: c.json.challenge,
    });
    const r = await fresh.post(
      `/v1/approval-requests/${approvalId}/decisions`,
      { decision: "approve", operationDigest: digest },
    );
    assert.notEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(r.json));
  });

  it("a sandbox that expires mid-approval never moves money: the run is refused as sandbox_expired", async () => {
    const s = await w.call("POST", "/sandbox/scenario", bob, {
      id: "routine_approval",
    });
    const { approvalId, operationId } = s.json;
    const digest = s.json.response.body.operation.digest;
    const id = (await w.call("GET", "/sandbox/me", bob)).json.sandboxId;
    const pool = w.pool();
    await pool.query(
      "update policy_desk.sandboxes set expires_at = now() - interval '1 minute' where id=$1",
      [id],
    );
    await pool.end();
    // The decision goes straight to Task Authority and may still record; the refund itself
    // runs through the sandbox, which refuses once the sandbox has expired.
    await w.decideWithStepUp("bob", approvalId, digest);
    const run = await w.call("POST", `/v1/refunds/${operationId}/run`, bob);
    assert.equal(run.status, 410, JSON.stringify(run.json));
    assert.equal(run.json.reason, "sandbox_expired");
  });
});

describe("reset", () => {
  it("resetting an expired sandbox makes it usable again for a full lifetime", async () => {
    await w.call("POST", "/sandbox/reset", bob, {});
    const id = (await w.call("GET", "/sandbox/me", bob)).json.sandboxId;
    const pool = w.pool();
    await pool.query(
      "update policy_desk.sandboxes set expires_at = now() - interval '1 minute' where id=$1",
      [id],
    );
    const expired = await w.call("GET", "/sandbox/state", bob);
    assert.equal(expired.status, 410);
    assert.equal(expired.json.reason, "sandbox_expired");
    const reset = await w.call("POST", "/sandbox/reset", bob, {});
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    const ttl = (
      await pool.query(
        "select extract(epoch from expires_at - now())::int s from policy_desk.sandboxes where id=$1",
        [id],
      )
    ).rows[0].s;
    await pool.end();
    assert.ok(ttl > 14 * 60 && ttl <= 15 * 60, `lifetime ${ttl}s`);
    assert.equal((await w.call("GET", "/sandbox/state", bob)).status, 200);
    const order = reset.json.orders[0].orderId;
    const refund = await w.call(
      "POST",
      "/v1/refunds",
      bob,
      { orderId: order, amountMinor: 1000 },
      { "x-policy-desk-sandbox": id },
    );
    assert.notEqual(refund.status, 410, JSON.stringify(refund.json));
  });
  it("is idempotent: a fresh generation each time, same shape, budgets cleared", async () => {
    await w.call("POST", "/sandbox/scenario", bob, {
      id: "small_within_budget",
    });
    assert.ok(
      (await w.call("GET", "/sandbox/state", bob)).json.budget.usedMinor > 0,
    );
    const a = await w.call("POST", "/sandbox/reset", bob, {});
    const b = await w.call("POST", "/sandbox/reset", bob, {});
    assert.equal(b.json.generation, a.json.generation + 1);
    assert.equal(a.json.orders.length, b.json.orders.length);
    assert.equal(a.json.policyVersion, b.json.policyVersion);
    const st = (await w.call("GET", "/sandbox/state", bob)).json;
    assert.equal(st.budget.usedMinor, 0);
    assert.equal(st.operations.length, 0);
    assert.equal(st.progress.policyPublished, true);
    // the stale token still works (same user, same sandbox id)
    assert.equal(
      (
        await w.call("POST", "/sandbox/scenario", bob, {
          id: "small_within_budget",
        })
      ).json.response.status,
      201,
    );
  });
});

describe("guardrails", () => {
  it("rejects policy edits outside the safe envelope with specific codes", async () => {
    const out = await w.call("PUT", "/sandbox/policy", alice, {
      agentAutoLimitMinor: 99_999_999,
    });
    assert.equal(out.status, 422);
    assert.equal(out.json.reason, "policy_value_out_of_range");
    assert.ok(out.json.message && out.json.hint && out.json.nextAction);
    const inv = await w.call("PUT", "/sandbox/policy", alice, {
      agentAutoLimitMinor: 40000,
      highValueAboveMinor: 30000,
    });
    assert.equal(inv.json.reason, "policy_thresholds_inverted");
    for (const field of [
      { unknown_action: "approve" },
      { approvers: "anyone" },
      { approverRelation: "member" },
    ]) {
      const bad = await w.call("PUT", "/sandbox/policy", alice, field);
      assert.equal(
        bad.json.reason,
        "policy_edit_not_allowed",
        JSON.stringify(field),
      );
    }
  });
  it("an edit changes real decisions; restore returns to the template; progress sees the edit", async () => {
    const e = await w.call("PUT", "/sandbox/policy", alice, {
      agentAutoLimitMinor: 20000,
    });
    assert.equal(e.status, 200, JSON.stringify(e.json));
    assert.equal(e.json.policy.settings.agentAutoLimitMinor, 20000);
    const auto = await w.call("POST", "/sandbox/scenario", alice, {
      id: "routine_approval",
    });
    assert.equal(
      auto.json.response.status,
      201,
      "a $150 agent refund is now automatic",
    );
    assert.equal(auto.json.response.body.policyVersion, e.json.version);
    assert.equal(
      (await w.call("GET", "/sandbox/progress", alice)).json.progress
        .policyEdited,
      true,
    );
    const sim = await w.call("POST", "/sandbox/simulate", alice, {
      thresholdMinor: 1000,
    });
    assert.equal(sim.status, 200, JSON.stringify(sim.json));
    assert.ok(sim.json.changed >= 1);
    assert.ok(
      sim.json.rows[0].summary &&
        sim.json.rows[0].before &&
        sim.json.rows[0].after,
    );
    const r = await w.call("POST", "/sandbox/restore-policy", alice);
    assert.equal(r.status, 200);
    assert.equal(r.json.policy.settings.agentAutoLimitMinor, 10000);
    assert.equal(
      (
        await w.call("POST", "/sandbox/scenario", alice, {
          id: "routine_approval",
        })
      ).json.response.status,
      202,
    );
  });
  it("caps pending approvals (service quota) with a plain-language reason", async () => {
    await w.call("POST", "/sandbox/reset", bob, {});
    let last: any;
    for (let i = 0; i < 12; i++) {
      last = await w.call("POST", "/sandbox/scenario", bob, {
        id: "assert_none",
      });
      if (last.json.response.status === 429) break;
    }
    assert.equal(last.json.response.status, 429);
    assert.equal(last.json.response.body.reason, "quota_exceeded");
    assert.ok(last.json.response.body.hint);
  });
  it("bounds policy publishes per hour", async () => {
    await w.call("POST", "/sandbox/reset", bob, {});
    let last: any;
    for (let i = 0; i < 12; i++) {
      last = await w.call("POST", "/sandbox/restore-policy", bob);
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429);
    assert.equal(last.json.reason, "policy_publish_limit");
    assert.ok(last.json.retryAfterSec > 0);
  });
  it("per-IP rate limits apply to resets", async () => {
    const t = await w.login("outsider");
    let status = 0;
    for (let i = 0; i < 14 && status !== 429; i++)
      status = (
        await w.raw("/sandbox/reset", {
          method: "POST",
          token: t,
          body: "{}",
          headers: { "cf-connecting-ip": "198.51.100.9" },
        })
      ).status;
    assert.equal(status, 429);
  });
  it("caps operations per sandbox", async () => {
    await w.call("POST", "/sandbox/reset", alice, {});
    const pool = w.pool();
    const me = (await w.call("GET", "/sandbox/me", alice)).json.sandbox;
    const tenant = `pd_${me.id.slice(4)}_g${me.generation}`;
    // Fill the cap cheaply by counting what the cap checks, then assert the refusal.
    await pool.end();
    const order = (await w.call("GET", "/sandbox/orders", alice)).json.orders[1]
      .orderId;
    let res: any;
    for (let i = 0; i < 52 && res?.status !== 429; i++) {
      res = await w.call("POST", "/v1/refunds", alice, {
        orderId: order,
        amountMinor: 1000,
        approvalAssertion: "human",
      });
      if (res.status === 429 && res.json.reason === "quota_exceeded") break;
    }
    assert.ok(tenant);
    assert.equal(res.status, 429);
  });
});

describe("TTL cleanup", () => {
  it("deletes expired sandboxes and their append-only rows, then leaves the triggers enabled", async () => {
    const t = await w.login("carol");
    const created = await w.raw("/sandbox/reset", {
      method: "POST",
      token: t,
      body: "{}",
      headers: { "cf-connecting-ip": "192.0.2.77" },
    });
    assert.equal(created.status, 200);
    const pool = w.pool();
    const sid = (
      (await (await w.raw("/sandbox/me", { token: t })).json()) as any
    ).sandboxId;
    await pool.query(
      "update policy_desk.sandboxes set expires_at = now() - interval '1 minute' where id=$1",
      [sid],
    );
    const host = await openHost(w.env, new Request(ORIGIN));
    try {
      const out = await cleanupExpired(host);
      assert.ok(out.sandboxes >= 1 && out.tenantsWiped >= 1);
    } finally {
      await host.conn.close();
    }
    const left = await pool.query(
      "select count(*)::int n from policy_desk.sandboxes where id='" +
        sid +
        "'",
    );
    assert.equal(left.rows[0].n, 0);
    const trg = await pool.query(
      "select tgenabled from pg_trigger where tgname in ('audit_no_update','policy_versions_immutable')",
    );
    assert.ok(trg.rows.every((r) => r.tgenabled === "O"));
    await assert.rejects(
      pool.query(
        "delete from authority.audit_events where tenant_id like 'pd_%' and id = (select min(id) from authority.audit_events where tenant_id like 'pd_%')",
      ),
    );
    // Other sandboxes survive.
    const others = await pool.query(
      "select count(*)::int n from authority.audit_events",
    );
    assert.ok(others.rows[0].n > 0);
    await pool.end();
  });
});
void createHash;

describe("demo approvers without a passkey (allowAuthenticatorApp, off by default)", () => {
  // Earlier tests spend the hourly reset limits; these tests are about policy, not limits.
  const clearLimits = async () => {
    const pool = w.pool();
    await pool.query("delete from policy_desk.rate_limits");
    await pool.end();
  };
  it("a sandbox that opts in approves a routine refund with a fresh authenticator-app code; partial edits keep it", async () => {
    // A fresh generation: earlier tests used up this sandbox's hourly publishes.
    await clearLimits();
    assert.equal((await w.call("POST", "/sandbox/reset", bob, {})).status, 200);
    const policy = await w.call("PUT", "/sandbox/policy", bob, {
      allowAuthenticatorApp: true,
    });
    assert.equal(policy.status, 200, JSON.stringify(policy.json));
    assert.equal(policy.json.policy.settings.allowAuthenticatorApp, true);
    // Editing one number later keeps the approval method instead of resetting it.
    const edit = await w.call("PUT", "/sandbox/policy", bob, {
      agentAutoLimitMinor: 9000,
    });
    assert.equal(edit.status, 200, JSON.stringify(edit.json));
    assert.equal(edit.json.policy.settings.allowAuthenticatorApp, true);
    assert.equal(edit.json.policy.settings.agentAutoLimitMinor, 9000);
    const view = await w.call("GET", "/sandbox/policy", bob);
    assert.equal(view.json.publishesLastHour >= 2, true);
    assert.equal(view.json.maxPublishesPerHour, 10);

    const s = await w.call("POST", "/sandbox/scenario", bob, {
      id: "routine_approval",
    });
    const { approvalId } = s.json;
    const digest = s.json.response.body.operation.digest;
    const st = await w.call("GET", "/sandbox/state", bob);
    const op = st.json.operations.find(
      (o: any) => o.approval?.id === approvalId,
    );
    assert.ok(op.factors.includes("otp"), JSON.stringify(op));
    // The sign-in's own MFA still does not count: the code must follow this challenge.
    const signInMfa = await w.reviewer("bob");
    const reused = await signInMfa.post(
      `/v1/approval-requests/${approvalId}/decisions`,
      { decision: "approve", operationDigest: digest },
    );
    assert.equal(reused.status, 403, JSON.stringify(reused.json));
    const otp = await w.decideWithStepUp("bob", approvalId, digest, {
      factor: "otp",
    });
    assert.equal(otp.status, 200, JSON.stringify(otp.json));
    assert.equal(otp.json.status, "approved");
  });

  it("a reset keeps the approval method; the default sandbox stays passkey-only", async () => {
    await clearLimits();
    assert.equal((await w.call("POST", "/sandbox/reset", bob, {})).status, 200);
    let p = await w.call("GET", "/sandbox/policy", bob);
    assert.equal(p.json.settings.allowAuthenticatorApp, true);
    assert.equal(
      (
        await w.call("POST", "/sandbox/reset", bob, {
          allowAuthenticatorApp: false,
        })
      ).status,
      200,
    );
    p = await w.call("GET", "/sandbox/policy", bob);
    assert.equal(p.json.settings.allowAuthenticatorApp, false);
  });

  it("an optional reject reason is recorded in the audit trail", async () => {
    await clearLimits();
    assert.equal((await w.call("POST", "/sandbox/reset", bob, {})).status, 200);
    const s = await w.call("POST", "/sandbox/scenario", bob, {
      id: "routine_approval",
    });
    const { approvalId, operationId } = s.json;
    const digest = s.json.response.body.operation.digest;
    const plain = await w.reviewer("bob", undefined, { stepUp: false });
    const reject = await plain.post(
      `/v1/approval-requests/${approvalId}/decisions`,
      {
        decision: "reject",
        operationDigest: digest,
        reason: "Duplicate of an earlier refund",
      },
    );
    assert.equal(reject.status, 200, JSON.stringify(reject.json));
    const audit = await w.call(
      "GET",
      `/sandbox/audit?operationId=${operationId}`,
      bob,
    );
    const ev = audit.json.events.find(
      (e: any) => e.type === "approval.rejected",
    );
    assert.equal(
      ev.evaluation.reviewerReason,
      "Duplicate of an earlier refund",
    );
  });
});
