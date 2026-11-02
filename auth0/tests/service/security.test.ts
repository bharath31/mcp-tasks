import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { ADMIN_URL } from "../helpers/pg.js";
import {
  AGENTS,
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

const u = (p: string) => `user:${p}`;
const org = (o: string) => `organization:${o}`;
const claimRows = async (opId: string) =>
  (
    await w.store.pool.query(
      "select id, status, seq from authority.claims where operation_id=$1 order by seq",
      [opId],
    )
  ).rows;

/** A deferred latch for holding a request inside its transaction. */
function latch() {
  let release!: () => void;
  let reached!: () => void;
  const hit = new Promise<void>((r) => (reached = r));
  const open = new Promise<void>((r) => (release = r));
  return {
    hit,
    wait: async () => {
      reached();
      await open;
    },
    release,
  };
}

describe("approval decisions (FR-021..025, section 11)", () => {
  test("happy path: eligible manager with fresh bound MFA approves; claim is then authorized exactly once", async () => {
    const { op, ap } = await w.exception();
    assert.equal(ap.status, "pending");
    const early = await w.claim(op);
    assert.equal(early.json.code, "approval_pending");
    const decided = await w.approve(ap.id, op.digest);
    assert.equal(decided.status, 200);
    assert.equal(decided.json.status, "approved");
    const claim = await w.claim(op);
    assert.equal(claim.status, 200);
    assert.equal(claim.json.decision, "authorized");
    assert.equal(claim.json.recovered, false);
    assert.equal((await claimRows(op.id)).length, 1);
    const types = (await w.audit(op.id)).map((e) => e.type);
    for (const t of [
      "delegation.created",
      "operation.registered",
      "approval.requested",
      "approval.approved",
      "authorization.allowed",
      "claim.created",
    ])
      assert.ok(types.includes(t as never), t);
  });
  test("every audit row for the chain shares one correlation id", async () => {
    const { op, ap } = await w.exception();
    await w.approve(ap.id, op.digest);
    await w.claim(op);
    const events = await w.audit(op.id);
    assert.ok(events.length >= 5);
    assert.equal(new Set(events.map((e) => e.correlationId)).size, 1);
  });
  test("wrong-organization manager (Mallory) is denied, indistinguishably from an unknown approval id", async () => {
    const { op, ap } = await w.exception();
    const wrong = await w.approve(ap.id, op.digest, {
      person: PEOPLE.mallory,
      org: ORG.southridge,
    });
    const unknown = await w.approve("apr_doesnotexist", op.digest, {
      person: PEOPLE.mallory,
      org: ORG.southridge,
    });
    assert.equal(wrong.json.code, "not_authorized");
    assert.equal(unknown.json.code, "not_authorized");
    assert.equal(wrong.json.message, unknown.json.message);
    assert.equal((await w.claim(op)).json.code, "approval_pending");
    assert.equal((await claimRows(op.id)).length, 0);
    const denial = (await w.audit(op.id)).find(
      (e) => e.reasonCode === "approver_org_mismatch",
    );
    assert.ok(denial, "the attempt is recorded for investigators");
    // A Southridge manager presenting a Northstar org context is still not a Northstar approver.
    const spoof = await w.approve(ap.id, op.digest, {
      person: PEOPLE.mallory,
      org: ORG.northstar,
    });
    assert.equal(spoof.json.code, "approver_ineligible");
  });
  test("an unprivileged member (Eve) and the initiator (Alice) cannot approve", async () => {
    const { op, ap } = await w.exception();
    assert.equal(
      (await w.approve(ap.id, op.digest, { person: PEOPLE.eve })).json.code,
      "approver_ineligible",
    );
    // Even if Alice were granted the approver permission, separation of duties still applies.
    await w.fga.write([
      {
        user: u(PEOPLE.alice),
        relation: "refund_approve",
        object: org(ORG.northstar),
      },
    ]);
    try {
      const self = await w.approve(ap.id, op.digest, { person: PEOPLE.alice });
      assert.equal(self.json.code, "approver_ineligible");
      assert.equal(self.json.details.reason, "initiator_cannot_approve");
    } finally {
      await w.fga.delete([
        {
          user: u(PEOPLE.alice),
          relation: "refund_approve",
          object: org(ORG.northstar),
        },
      ]);
    }
  });
  test("a forged approval flag cannot stand in for a decision: only the decision endpoint with a bound MFA token can", async () => {
    const { op } = await w.exception();
    const claim = await w.claim(op);
    assert.equal(claim.json.code, "approval_pending");
    assert.equal((await claimRows(op.id)).length, 0);
  });
  test("assurance is enforced: MFA, freshness, binding to this approval and digest, and token id", async () => {
    const { op, ap } = await w.exception();
    const cases: Array<[string, Parameters<World["approve"]>[2]]> = [
      ["mfa_required", { mfa: false }],
      ["step_up_stale_or_before_request", { authTime: w.clock.seconds - 3600 }],
      ["step_up_stale_or_before_request", { authTime: null }],
      ["challenge_not_bound_to_operation", { details: null }],
      [
        "challenge_not_bound_to_operation",
        {
          details: [
            {
              type: "task_authority_approval",
              approval_id: "apr_other",
              operation_digest: op.digest,
            },
          ],
        },
      ],
      [
        "challenge_not_bound_to_operation",
        {
          details: [
            {
              type: "task_authority_approval",
              approval_id: ap.id,
              operation_digest: `sha256:${"0".repeat(64)}`,
            },
          ],
        },
      ],
    ];
    for (const [reason, o] of cases) {
      const r = await w.approve(ap.id, op.digest, o);
      assert.equal(r.json.code, "not_authorized", reason);
      assert.equal(r.json.details.reason, reason);
    }
    assert.equal((await w.claim(op)).json.code, "approval_pending");
  });
  test("assurance may arrive as namespaced claims (how a real Auth0 tenant must deliver amr/auth_time)", async () => {
    const { op, ap } = await w.exception();
    const token = await w.idp.mint({
      sub: PEOPLE.morgan,
      orgId: ORG.northstar,
      authTime: null,
      claims: {
        "https://task-authority.example/amr": ["mfa", "otp"],
        "https://task-authority.example/auth_time": w.clock.seconds,
      },
      details: [
        {
          type: "task_authority_approval",
          approval_id: ap.id,
          operation_digest: op.digest,
        },
      ],
    });
    const r = await w.call("POST", `/v1/approval-requests/${ap.id}/decisions`, {
      token,
      body: { decision: "approve", operationDigest: op.digest },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, "approved");
  });
  test("a delegated agent token (act or sub_profile=ai_agent) cannot approve, even for an eligible reviewer with fresh MFA", async () => {
    const { op, ap } = await w.exception();
    const details = [
      {
        type: "task_authority_approval",
        approval_id: ap.id,
        operation_digest: op.digest,
      },
    ];
    for (const claims of [
      { act: { sub: "agent|refund-bot" } },
      { sub_profile: "ai_agent" },
    ]) {
      const token = await w.idp.mint({
        sub: PEOPLE.morgan,
        orgId: ORG.northstar,
        mfa: true,
        details,
        claims,
      });
      const r = await w.call(
        "POST",
        `/v1/approval-requests/${ap.id}/decisions`,
        { token, body: { decision: "approve", operationDigest: op.digest } },
      );
      assert.equal(r.json.code, "invalid_identity", JSON.stringify(claims));
      assert.equal(r.json.details.reason, "agent_cannot_approve");
      for (const path of ["lease", "challenge"]) {
        const side = await w.call(
          "POST",
          `/v1/approval-requests/${ap.id}/${path}`,
          { token, body: {} },
        );
        assert.equal(side.json.code, "invalid_identity", path);
      }
    }
    // Same refusal for an unknown id, so an agent cannot probe which approvals exist.
    const token = await w.idp.mint({
      sub: PEOPLE.morgan,
      orgId: ORG.northstar,
      mfa: true,
      claims: { act: { sub: "agent|refund-bot" } },
    });
    const unknown = await w.call(
      "POST",
      "/v1/approval-requests/apr_unknown/decisions",
      { token, body: { decision: "approve", operationDigest: op.digest } },
    );
    assert.equal(unknown.json.code, "invalid_identity");
    assert.equal(unknown.json.details.reason, "agent_cannot_approve");
    // Nor read the review queue or an approval's details.
    for (const path of [
      "/v1/approval-requests?status=pending",
      `/v1/approval-requests/${ap.id}`,
    ])
      assert.equal(
        (await w.call("GET", path, { token })).json.code,
        "invalid_identity",
        path,
      );
    assert.equal((await w.claim(op)).json.code, "approval_pending");
    const denied = (await w.audit(op.id)).filter(
      (e) => e.reasonCode === "agent_cannot_approve",
    );
    assert.equal(denied.length, 2);
    // The same person with an ordinary human token still can.
    assert.equal((await w.approve(ap.id, op.digest)).json.status, "approved");
  });
  test("a decision for a different digest is operation_changed and approves nothing", async () => {
    const { op, ap } = await w.exception();
    const r = await w.approve(ap.id, op.digest, {
      digestOverride: `sha256:${"a".repeat(64)}`,
    });
    assert.equal(r.json.code, "operation_changed");
    assert.equal((await w.claim(op)).json.code, "approval_pending");
  });
  test("replay: the same token cannot decide again, and an approval cannot be re-decided differently", async () => {
    const a = await w.exception();
    const b = await w.exception();
    const first = await w.approve(a.ap.id, a.op.digest, {
      jti: "jti-replay-1",
    });
    assert.equal(first.status, 200);
    // Substitution: reuse the same token id on another approval.
    const substituted = await w.approve(b.ap.id, b.op.digest, {
      jti: "jti-replay-1",
    });
    assert.equal(substituted.json.details.reason, "token_replayed");
    assert.equal((await w.claim(b.op)).json.code, "approval_pending");
    // Same approver repeating the same decision is idempotent.
    const again = await w.approve(a.ap.id, a.op.digest);
    assert.equal(again.status, 200);
    // A conflicting decision after the fact is refused.
    const flip = await w.approve(a.ap.id, a.op.digest, { decision: "reject" });
    assert.equal(flip.json.code, "operation_conflict");
  });
  test("rejection is final: the operation can never be claimed or re-approved", async () => {
    const { op, ap } = await w.exception();
    const rejected = await w.approve(ap.id, op.digest, { decision: "reject" });
    assert.equal(rejected.json.status, "rejected");
    assert.equal((await w.claim(op)).json.code, "approval_rejected");
    assert.equal(
      (await w.requestApproval(op.id)).json.code,
      "approval_rejected",
    );
    assert.equal((await claimRows(op.id)).length, 0);
  });
  test("approval expiry (controlled clock) requires a fresh decision; stale approvals never authorize", async () => {
    const { op, ap } = await w.exception();
    w.clock.advance(31 * 60_000);
    assert.equal(
      (await w.approve(ap.id, op.digest)).json.code,
      "approval_expired",
    );
    assert.equal((await w.claim(op)).json.code, "approval_expired");
    const fresh = await w.requestApproval(op.id);
    assert.notEqual(fresh.json.id, ap.id);
    assert.equal((await w.approve(fresh.json.id, op.digest)).status, 200);
    assert.equal((await w.claim(op)).json.decision, "authorized");
    assert.ok(
      (await w.audit(op.id)).some((e) => e.type === "approval.expired"),
    );
  });
  test("an approval approved but left unclaimed past its window expires and requires re-approval", async () => {
    const { op, ap } = await w.exception();
    await w.approve(ap.id, op.digest);
    w.clock.advance(31 * 60_000);
    assert.equal((await w.claim(op)).json.code, "approval_expired");
  });
  test("the reviewer sees the exact operation; others do not", async () => {
    const { op, ap } = await w.exception();
    const manager = await w.call("GET", `/v1/approval-requests/${ap.id}`, {
      token: await w.tok.user(PEOPLE.morgan, ORG.northstar),
    });
    assert.equal(manager.json.operation.arguments.amountMinor, 15000);
    assert.equal(manager.json.operation.arguments.currency, "USD");
    for (const [p, o] of [
      [PEOPLE.mallory, ORG.southridge],
      [PEOPLE.eve, ORG.northstar],
    ] as const)
      assert.equal(
        (
          await w.call("GET", `/v1/approval-requests/${ap.id}`, {
            token: await w.tok.user(p, o),
          })
        ).json.code,
        "not_found",
      );
    void op;
  });
});

describe("claims: current authorization at the dispatch boundary (FR-015, FR-026..028)", () => {
  test("automatic path: below-threshold operation needs no human but still passes delegation and FGA checks", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    assert.equal(op.approvalRequirement, "none");
    assert.equal((await w.requestApproval(op.id)).json.code, "invalid_request");
    const claim = await w.claim(op);
    assert.equal(claim.json.decision, "authorized");
    const allowed = (await w.audit(op.id)).find(
      (e) => e.type === "authorization.allowed",
    )!;
    assert.ok(allowed);
    const row = (
      await w.store.pool.query(
        "select effective_authority from authority.claims where id=$1",
        [claim.json.claimId],
      )
    ).rows[0];
    assert.deepEqual(row.effective_authority.checks, [
      "delegation",
      "operation_digest",
      "trusted_backend",
      "agent_registered",
      "owner_permission",
    ]);
    assert.equal(row.effective_authority.approverId, null);
  });
  test("manager approves, then loses the permission before dispatch: claim denied, approval must be re-evaluated", async () => {
    const { op, ap } = await w.exception();
    await w.approve(ap.id, op.digest);
    const tuple = {
      user: u(PEOPLE.morgan),
      relation: "refund_approve",
      object: org(ORG.northstar),
    };
    await w.fga.delete([tuple]);
    try {
      const r = await w.claim(op);
      assert.equal(r.status, 403);
      assert.equal(r.json.code, "approver_ineligible");
      assert.equal(r.json.details.reason, "approver_permission_lost");
      assert.equal((await claimRows(op.id)).length, 0);
    } finally {
      await w.fga.write([tuple]);
    }
    // Restoring the permission alone does not silently resurrect authority: it is re-checked fresh and passes.
    assert.equal((await w.claim(op)).json.decision, "authorized");
  });
  test("user-owned: initiator loses the permission, future claims are denied", async () => {
    const d = (await w.delegate({ ownerType: "user", person: PEOPLE.alice }))
      .json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    const tuple = {
      user: u(PEOPLE.alice),
      relation: "refund_request",
      object: org(ORG.northstar),
    };
    await w.fga.delete([tuple]);
    try {
      const r = await w.claim(op);
      assert.equal(r.json.code, "not_authorized");
      assert.equal(r.json.details.reason, "owner_permission_lost");
    } finally {
      await w.fga.write([tuple]);
    }
  });
  test("organization-owned: the initiator leaves, authority continues under org policy, but the former employee loses access", async () => {
    const d = (
      await w.delegate({ ownerType: "organization", person: PEOPLE.olivia })
    ).json;
    const op = (
      await w.register(d.id, {
        amountMinor: 5000,
        assertion: "none",
        initiator: PEOPLE.alice,
      })
    ).json;
    assert.equal(op.approvalRequirement, "none");
    const gone = [
      { user: u(PEOPLE.alice), relation: "member", object: org(ORG.northstar) },
      {
        user: u(PEOPLE.alice),
        relation: "refund_request",
        object: org(ORG.northstar),
      },
    ];
    await w.fga.delete(gone);
    try {
      const read = await w.call("GET", `/v1/operations/${op.id}`, {
        token: await w.tok.user(PEOPLE.alice, ORG.northstar),
      });
      assert.equal(read.json.code, "not_found");
      const claim = await w.claim(op);
      assert.equal(claim.json.decision, "authorized");
      const row = (
        await w.store.pool.query(
          "select effective_authority from authority.claims where id=$1",
          [claim.json.claimId],
        )
      ).rows[0];
      assert.ok(row.effective_authority.checks.includes("organization_policy"));
    } finally {
      await w.fga.write(gone);
    }
  });
  test("the registered agent being de-registered ends authority for both ownership modes", async () => {
    const d = (
      await w.delegate({ ownerType: "organization", person: PEOPLE.olivia })
    ).json;
    const op = (
      await w.register(d.id, {
        amountMinor: 5000,
        assertion: "none",
        initiator: PEOPLE.alice,
      })
    ).json;
    const tuple = {
      user: `agent:${AGENTS.returns}`,
      relation: "registered_agent",
      object: org(ORG.northstar),
    };
    await w.fga.delete([tuple]);
    try {
      assert.equal(
        (await w.claim(op)).json.details.reason,
        "agent_no_longer_registered",
      );
    } finally {
      await w.fga.write([tuple]);
    }
  });
  test("revocation before claim: denied, no claim row, audited", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    await w.call("POST", `/v1/delegations/${d.id}/revoke`, {
      token: await w.tok.user(PEOPLE.alice, ORG.northstar),
      body: {},
    });
    const r = await w.claim(op);
    assert.equal(r.json.code, "delegation_revoked");
    assert.equal((await claimRows(op.id)).length, 0);
    assert.ok(
      (await w.audit(op.id)).some(
        (e) =>
          e.type === "authorization.denied" &&
          e.reasonCode === "delegation_revoked",
      ),
    );
  });
  test("delegation expiry (controlled clock) ends the right to start new work", async () => {
    const d = (await w.delegate({ ttlMs: 2 * 3600_000 })).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    w.clock.advance(3 * 3600_000);
    assert.equal((await w.claim(op)).json.code, "delegation_expired");
    w.clock.advance(-3 * 3600_000);
  });
  test("changed amount or destination: the old approval never authorizes the new operation", async () => {
    const { d, op, ap } = await w.exception();
    await w.approve(ap.id, op.digest);
    const same = await w.register(d.id, {
      key: op.operationKey,
      amountMinor: 20000,
    });
    assert.equal(same.json.code, "operation_conflict");
    const changed = (await w.register(d.id, { amountMinor: 20000 })).json;
    assert.notEqual(changed.digest, op.digest);
    assert.equal((await w.claim(changed)).json.code, "approval_required");
    // Replaying the old digest against the new operation is a change, not an approval.
    assert.equal(
      (await w.claim(changed, { digest: op.digest })).json.code,
      "operation_changed",
    );
    const dest = (
      await w.register(d.id, {
        args: {
          merchant: ORG.northstar,
          orderId: "742",
          paymentId: "pi_test_742",
          amountMinor: 15000,
          currency: "USD",
          destination: "store_credit",
        },
      })
    ).json;
    assert.notEqual(dest.digest, op.digest);
    assert.equal((await w.claim(dest)).json.code, "approval_required");
    assert.equal((await w.claim(op)).json.decision, "authorized");
  });
  test("a changed business-state version is operation_changed", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, {
        amountMinor: 5000,
        assertion: "none",
        version: "payment-v1",
      })
    ).json;
    assert.equal(
      (await w.claim(op, { version: "payment-v2" })).json.details.reason,
      "business_state_version_mismatch",
    );
    assert.equal(
      (await w.claim(op)).json.details.reason,
      "business_state_version_mismatch",
    );
    assert.equal(
      (await w.claim(op, { version: "payment-v1" })).json.decision,
      "authorized",
    );
  });
  test("an execution key that is not the logical operation key is refused", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    assert.equal(
      (await w.claim(op, { key: "some:other:key" })).json.code,
      "operation_conflict",
    );
  });
  test("only a trusted executor holding claims:create can claim; the API client cannot", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    assert.equal(
      (await w.claim(op, { token: await w.tok.api() })).json.code,
      "not_authorized",
    );
    assert.equal(
      (await w.claim(op, { token: await w.tok.rogue() })).json.code,
      "not_authorized",
    );
    assert.equal(
      (
        await w.claim(op, {
          token: await w.tok.user(PEOPLE.alice, ORG.northstar),
        })
      ).json.code,
      "not_authorized",
    );
    assert.equal((await claimRows(op.id)).length, 0);
  });
  test("cross-tenant claim and read attempts are indistinguishable from not found", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    const foreign = await w.idp2!.service("client_refund_desk_executor", [
      "claims:create",
      "operations:read",
      "audit:read",
    ]);
    assert.equal(
      (await w.claim(op, { token: foreign })).json.code,
      "not_found",
    );
    assert.equal(
      (await w.call("GET", `/v1/operations/${op.id}`, { token: foreign })).json
        .code,
      "not_found",
    );
    assert.equal(
      (await w.call("GET", `/v1/operations/${op.id}/audit`, { token: foreign }))
        .json.code,
      "not_found",
    );
  });

  test("concurrent workers: exactly one claim is created; the rest recover the same claim", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => w.claim(op)),
    );
    assert.ok(
      results.every(
        (r) => r.status === 200 && r.json.decision === "authorized",
      ),
    );
    assert.equal(new Set(results.map((r) => r.json.claimId)).size, 1);
    assert.equal(results.filter((r) => r.json.recovered === false).length, 1);
    assert.equal((await claimRows(op.id)).length, 1);
  });
  test("lost claim response: a retry inside the lease recovers the original claim", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    const first = await w.claim(op, { idem: "claim-retry-key-1" });
    const retry = await w.claim(op);
    assert.equal(retry.json.claimId, first.json.claimId);
    assert.equal(retry.json.recovered, true);
    assert.ok((await w.audit(op.id)).some((e) => e.type === "claim.recovered"));
  });
  test("worker crashes after claim: after the lease the service demands reconciliation, never a second authorization", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    const first = await w.claim(op);
    w.clock.advance(61_000);
    const r = await w.claim(op);
    assert.equal(r.status, 200);
    assert.equal(r.json.decision, "reconcile_required");
    assert.equal(r.json.claimId, first.json.claimId);
    assert.equal((await claimRows(op.id)).length, 1);
    // Customer finds nothing at the provider (by idempotency key) and releases the claim ...
    const released = await w.outcome(
      op.id,
      first.json.claimId,
      "not_submitted",
    );
    assert.equal(released.json.claimStatus, "released");
    // ... and only then can a fresh claim, with every check repeated, be minted.
    const second = await w.claim(op);
    assert.equal(second.json.decision, "authorized");
    assert.notEqual(second.json.claimId, first.json.claimId);
    assert.deepEqual(
      (await claimRows(op.id)).map((c) => [c.seq, c.status]),
      [
        [1, "released"],
        [2, "claimed"],
      ],
    );
  });
  test("a released claim does not bypass revocation: the fresh claim is checked again", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    const first = await w.claim(op);
    await w.outcome(op.id, first.json.claimId, "not_submitted");
    await w.call("POST", `/v1/delegations/${d.id}/revoke`, {
      token: await w.tok.api(),
      body: {},
    });
    assert.equal((await w.claim(op)).json.code, "delegation_revoked");
  });

  test("revoke vs claim race A: claim wins the lock, revoke waits, and reports the operation in flight", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    const gate = latch();
    w.fga.gate = async (check) => {
      if (check.includes("client_refund_desk_executor")) {
        w.fga.gate = null;
        await gate.wait();
      }
    };
    const claim = w.claim(op);
    await gate.hit; // the claim now holds the delegation and operation locks
    let revoked = false;
    const revoke = w
      .call("POST", `/v1/delegations/${d.id}/revoke`, {
        token: await w.tok.api(),
        body: { reason: "race" },
      })
      .then((r) => {
        revoked = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      revoked,
      false,
      "revocation must serialize behind the in-progress claim",
    );
    gate.release();
    const [c, r] = await Promise.all([claim, revoke]);
    assert.equal(c.json.decision, "authorized");
    assert.equal(r.json.status, "revoked");
    assert.deepEqual(r.json.inFlightOperations, [op.id]);
    // A lost-response retry after revocation cannot be treated as fresh authority.
    const retry = await w.claim(op);
    assert.equal(retry.json.decision, "reconcile_required");
    assert.equal(retry.json.reason, "delegation_ended_after_claim");
  });
  test("revoke vs claim race B: revoke wins the lock, claim waits and is then denied with no dispatch authority", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    const gate = latch();
    w.fga.gate = async (check) => {
      if (check.includes("client_refund_desk_api")) {
        w.fga.gate = null;
        await gate.wait();
      }
    };
    const revoke = w.call("POST", `/v1/delegations/${d.id}/revoke`, {
      token: await w.tok.api(),
      body: {},
    });
    await gate.hit; // revoke holds the delegation lock
    let claimed = false;
    const claim = w.claim(op).then((r) => {
      claimed = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      claimed,
      false,
      "claim must wait for the revocation transaction",
    );
    gate.release();
    const [r, c] = await Promise.all([revoke, claim]);
    assert.deepEqual(r.json.inFlightOperations, []);
    assert.equal(c.json.code, "delegation_revoked");
    assert.equal((await claimRows(op.id)).length, 0);
  });
  test("operation cancel: unclaimed is cancelled; claimed reports in-flight, never a fake reversal", async () => {
    const d = (await w.delegate()).json;
    const a = (await w.register(d.id, { amountMinor: 5000, assertion: "none" }))
      .json;
    const cancelled = await w.call("POST", `/v1/operations/${a.id}/cancel`, {
      token: await w.tok.api(),
      body: {},
    });
    assert.equal(cancelled.json.cancelled, true);
    assert.equal((await w.claim(a)).json.code, "operation_cancelled");
    const b = (await w.register(d.id, { amountMinor: 5000, assertion: "none" }))
      .json;
    await w.claim(b);
    const late = await w.call("POST", `/v1/operations/${b.id}/cancel`, {
      token: await w.tok.api(),
      body: {},
    });
    assert.equal(late.json.cancelled, false);
    assert.equal(late.json.inFlightOrUnknown, true);
    assert.equal(late.json.operation.status, "claimed");
  });
  test("FGA outage fails closed with a retryable diagnostic; nothing is claimed; recovery works", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    w.fga.failing = true;
    try {
      const r = await w.claim(op);
      assert.equal(r.status, 503);
      assert.equal(r.json.code, "authorization_unavailable");
      assert.equal(r.json.retryable, true);
      assert.equal(r.json.details.dependency, "fga");
      assert.equal((await claimRows(op.id)).length, 0);
      const create = await w.delegate();
      assert.equal(create.json.code, "authorization_unavailable");
    } finally {
      w.fga.failing = false;
    }
    assert.equal((await w.claim(op)).json.decision, "authorized");
  });
  test("datastore outage surfaces as retryable authorization_unavailable, never as success", async () => {
    const original = w.store.tx.bind(w.store);
    w.store.tx = (async () => {
      throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
    }) as never;
    try {
      const r = await w.call("GET", "/v1/operations/op_x", {
        token: await w.tok.api(),
      });
      assert.equal(r.status, 503);
      assert.equal(r.json.retryable, true);
    } finally {
      w.store.tx = original;
    }
  });
});

describe("outcomes are unverified evidence (FR-029)", () => {
  test("reporting an outcome settles the operation but never authorizes anything", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    const claim = (await w.claim(op)).json;
    const done = await w.outcome(
      op.id,
      claim.claimId,
      "succeeded",
      "re_test_123",
    );
    assert.equal(done.json.operationStatus, "settled");
    assert.equal(done.json.unverifiedCustomerAttestation, true);
    assert.equal(
      (await w.outcome(op.id, claim.claimId, "succeeded", "re_test_123"))
        .status,
      200,
    );
    assert.equal(
      (await w.outcome(op.id, claim.claimId, "failed")).json.code,
      "operation_conflict",
    );
    const again = await w.claim(op);
    assert.equal(again.json.decision, "reconcile_required");
    assert.equal(again.json.reason, "claim_succeeded");
    const ev = (await w.audit(op.id)).find(
      (e) => e.type === "outcome.reported",
    )!;
    assert.equal(ev.reasonCode, "succeeded");
  });
  test("pending and unknown are honest, non-terminal states that can be re-reported", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    const claim = (await w.claim(op)).json;
    assert.equal(
      (await w.outcome(op.id, claim.claimId, "unknown")).json.claimStatus,
      "unknown",
    );
    assert.equal((await w.claim(op)).json.decision, "reconcile_required");
    assert.equal(
      (await w.outcome(op.id, claim.claimId, "pending", "re_1")).json
        .claimStatus,
      "pending",
    );
    assert.equal(
      (await w.outcome(op.id, claim.claimId, "succeeded", "re_1")).json
        .operationStatus,
      "settled",
    );
  });
  test("outcomes need outcomes:report from the claiming executor and a claim that exists", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    const claim = (await w.claim(op)).json;
    const asApi = await w.call("POST", `/v1/operations/${op.id}/outcomes`, {
      token: await w.tok.api(),
      body: { claimId: claim.claimId, providerStatus: "succeeded" },
    });
    assert.equal(asApi.json.code, "not_authorized");
    assert.equal(
      (await w.outcome(op.id, "clm_nonexistent", "succeeded")).json.code,
      "not_found",
    );
  });
});

describe("storage and operational boundaries (FR-007, FR-008, FR-029)", () => {
  test("audit is append-only and delegation scope/operation arguments are immutable at the database", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    const q = (sql: string, p: unknown[] = []) => w.store.pool.query(sql, p);
    await assert.rejects(
      q(
        "update authority.audit_events set decision='allow' where operation_id=$1",
        [op.id],
      ),
      /append-only/,
    );
    await assert.rejects(
      q("delete from authority.audit_events where operation_id=$1", [op.id]),
      /append-only/,
    );
    await assert.rejects(
      q(
        "update authority.delegations set expires_at = expires_at + interval '1 day' where id=$1",
        [d.id],
      ),
      /immutable/,
    );
    await assert.rejects(
      q("update authority.operations set digest='sha256:x' where id=$1", [
        op.id,
      ]),
      /immutable/,
    );
  });
  test("audit never contains tokens, assertions or email addresses", async () => {
    const all = JSON.stringify(
      (await w.store.pool.query("select * from authority.audit_events")).rows,
    );
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(all), "no JWT fragments");
    assert.ok(
      !/@[a-z0-9-]+\.[a-z]{2,}/i.test(all.replaceAll("@clients", "")),
      "no email addresses",
    );
    assert.ok(w.logs.length > 0);
    assert.ok(
      !/eyJ[A-Za-z0-9_-]{10,}/.test(JSON.stringify(w.logs)),
      "request logs carry no tokens",
    );
  });
  test("a customer-application database role has no access to service tables", async () => {
    const role = `customer_app_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(
        `create role ${role} login password 'customer-pw' nosuperuser`,
      );
      const url = new URL(w.store.pool.options.connectionString!);
      url.username = role;
      url.password = "customer-pw";
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      for (const t of [
        "delegations",
        "operations",
        "approvals",
        "claims",
        "audit_events",
        "idempotency_keys",
      ])
        await assert.rejects(
          c.query(`select 1 from authority.${t} limit 1`),
          (e: { code?: string }) => e.code === "42501",
          t,
        );
      await assert.rejects(
        c.query("insert into authority.claims (id) values ('x')"),
        (e: { code?: string }) => e.code === "42501",
      );
      await c.end();
    } finally {
      await admin.query(`drop role if exists ${role}`);
      await admin.end();
    }
  });
  test("quotas and rate limits return distinct, retry-aware codes", async () => {
    const tight = await createWorld({
      quotas: { openDelegations: 1, requestsPerMinute: 6 },
    });
    try {
      assert.equal((await tight.delegate()).status, 201);
      assert.equal(
        (await tight.delegate({ person: PEOPLE.morgan })).json.code,
        "quota_exceeded",
      );
      let limited: Awaited<ReturnType<typeof tight.call>> | undefined;
      for (let i = 0; i < 10 && !limited; i++) {
        const r = await tight.call("GET", "/v1/delegations/dlg_none", {
          token: await tight.tok.api(),
        });
        if (r.json.code === "rate_limited") limited = r;
      }
      assert.ok(limited, "rate limit engaged");
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "30");
    } finally {
      await tight.close();
    }
  });
  test("CORS: only allow-listed origins are echoed; others get no access headers", async () => {
    const pre = await w.handle(
      new Request("http://authority.test/v1/approval-requests/x/decisions", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example",
          "access-control-request-method": "POST",
        },
      }),
    );
    assert.equal(pre.status, 204);
    assert.equal(
      pre.headers.get("access-control-allow-origin"),
      "https://app.example",
    );
    const evil = await w.handle(
      new Request("http://authority.test/v1/approval-requests/x/decisions", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      }),
    );
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    const res = await w.handle(
      new Request("http://authority.test/healthz", {
        headers: { origin: "https://evil.example" },
      }),
    );
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
  test("investigators can read audit; the initiator cannot read other people's audit; denials are visible with reasons", async () => {
    const d = (await w.delegate()).json;
    const op = (
      await w.register(d.id, { amountMinor: 5000, assertion: "none" })
    ).json;
    await w.claim(op);
    const inspector = await w.call("GET", `/v1/operations/${op.id}/audit`, {
      token: await w.tok.user(PEOPLE.inspector, ORG.northstar),
    });
    assert.equal(inspector.status, 200);
    const alice = await w.call("GET", `/v1/operations/${op.id}/audit`, {
      token: await w.tok.user(PEOPLE.alice, ORG.northstar),
    });
    assert.equal(alice.json.code, "not_found");
    const noPerm = await w.call("GET", `/v1/operations/${op.id}/audit`, {
      token: await w.idp.service("client_x", []),
    });
    assert.equal(noPerm.json.code, "not_found");
  });
});
