import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createWorld, ORG, PEOPLE, type World } from "../helpers/world.js";

let w: World;
before(async () => {
  w = await createWorld();
});
after(async () => {
  await w.close();
});

const requester = {
  user: `user:${PEOPLE.alice}`,
  relation: "refund_request",
  object: `organization:${ORG.northstar}`,
};

/** A $150 exception owned by Alice, with the policy snapshot rewritten for the case. */
async function prepare(
  o: {
    selfApproval?: "owner";
    quorum?: number;
    tier?: Record<string, unknown>;
    ownerType?: "user" | "organization";
  } = {},
) {
  const { op, ap } = await w.exception({
    ownerType: o.ownerType,
    delegator: o.ownerType === "organization" ? PEOPLE.olivia : PEOPLE.alice,
  });
  await w.store.pool.query(
    "update authority.operations set policy_details=$2 where id=$1",
    [
      op.id,
      JSON.stringify({
        decision: "approval_required",
        reasonCode: "policy_approval_required",
        policyVersion: "test.v1",
        ruleIds: ["test"],
        budgetRuleIds: [],
        assurance: o.tier ?? { assurance: "per_operation", max_age: 300 },
        quorum: o.quorum ?? 1,
        requesterRelation: "refund_request",
        ...(o.selfApproval ? { selfApproval: o.selfApproval } : {}),
      }),
    ],
  );
  return { op, ap };
}

async function ownerDecides(
  op: { digest: string },
  ap: { id: string },
  amr = ["pwd", "mfa", "webauthn-platform"],
  decision: "approve" | "reject" = "approve",
  sub: string = PEOPLE.alice,
) {
  const token = await w.idp.mint({
    sub,
    orgId: ORG.northstar,
    mfa: true,
    claims: { amr },
    details: [
      {
        type: "task_authority_approval",
        approval_id: ap.id,
        operation_digest: op.digest,
      },
    ],
  });
  return w.call("POST", `/v1/approval-requests/${ap.id}/decisions`, {
    token,
    body: { decision, operationDigest: op.digest },
  });
}

test("separation of duties is the default: the owner cannot approve their agent's operation", async () => {
  const { op, ap } = await prepare();
  const r = await ownerDecides(op, ap);
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.equal(r.json.details.reason, "initiator_cannot_approve");
  const view = await w.call("GET", `/v1/operations/${op.id}`, {
    token: await w.tok.api(),
  });
  assert.equal(view.json.ownerApproval, false);
});

test("self_approval owner: the owner approves with a passkey and the agent's claim executes once", async () => {
  const { op, ap } = await prepare({ selfApproval: "owner" });
  const view = await w.call("GET", `/v1/operations/${op.id}`, {
    token: await w.tok.api(),
  });
  assert.equal(view.json.ownerApproval, true);
  // The owner sees their own pending approval in the same queue reviewers use.
  const queue = await w.call("GET", "/v1/approval-requests?status=pending", {
    token: await w.tok.user(PEOPLE.alice, ORG.northstar),
  });
  assert.ok(queue.json.approvals.some((a: any) => a.id === ap.id));

  const r = await ownerDecides(op, ap);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const claim = await w.claim(op);
  assert.equal(claim.json.decision, "authorized", JSON.stringify(claim.json));
  const again = await w.claim(op, { idem: "second-attempt" });
  assert.notEqual(again.json.claimId, undefined);
  assert.equal(again.json.claimId, claim.json.claimId);
});

test("self_approval owner still demands a phishing-resistant factor bound to the operation", async () => {
  const { op, ap } = await prepare({ selfApproval: "owner" });
  for (const amr of [
    ["pwd", "mfa"],
    ["pwd", "mfa", "otp"],
  ]) {
    const r = await ownerDecides(op, ap, amr);
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal(r.json.details.reason, "factor_not_satisfied");
  }
  // A tier that also accepts OTP for reviewers still needs a passkey from the owner.
  const lenient = await prepare({
    selfApproval: "owner",
    tier: {
      assurance: "per_operation",
      max_age: 300,
      factors: ["webauthn-roaming", "otp"],
    },
  });
  const otp = await ownerDecides(lenient.op, lenient.ap, ["pwd", "mfa", "otp"]);
  assert.equal(otp.json.details?.reason, "factor_not_satisfied");
  assert.equal(
    (
      await ownerDecides(lenient.op, lenient.ap, [
        "pwd",
        "mfa",
        "webauthn-roaming",
      ])
    ).status,
    200,
  );
  // A token minted for a different operation's digest is refused.
  const other = await prepare({ selfApproval: "owner" });
  const crossed = await w.call(
    "POST",
    `/v1/approval-requests/${ap.id}/decisions`,
    {
      token: await w.idp.mint({
        sub: PEOPLE.alice,
        orgId: ORG.northstar,
        mfa: true,
        claims: { amr: ["pwd", "mfa", "webauthn-platform"] },
        details: [
          {
            type: "task_authority_approval",
            approval_id: other.ap.id,
            operation_digest: other.op.digest,
          },
        ],
      }),
      body: { decision: "approve", operationDigest: op.digest },
    },
  );
  assert.notEqual(crossed.status, 200);
});

test("self_approval owner never applies to multi-party quorum or organization-owned agents", async () => {
  const quorum = await prepare({ selfApproval: "owner", quorum: 2 });
  const q = await ownerDecides(quorum.op, quorum.ap);
  assert.equal(q.json.details?.reason, "initiator_cannot_approve");

  const orgOwned = await prepare({
    selfApproval: "owner",
    ownerType: "organization",
  });
  assert.ok(orgOwned.ap.id, JSON.stringify(orgOwned));
  const o = await ownerDecides(
    orgOwned.op,
    orgOwned.ap,
    undefined,
    "approve",
    PEOPLE.olivia,
  );
  assert.equal(o.json.details?.reason, "initiator_cannot_approve");
});

test("an owner who loses the requester permission can neither approve nor execute an approval they gave", async () => {
  const before = await prepare({ selfApproval: "owner" });
  await w.fga.delete([requester]);
  try {
    const r = await ownerDecides(before.op, before.ap);
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal(r.json.code, "approver_ineligible");
  } finally {
    await w.fga.write([requester]);
  }

  const { op, ap } = await prepare({ selfApproval: "owner" });
  assert.equal((await ownerDecides(op, ap)).status, 200);
  await w.fga.delete([requester]);
  try {
    const claim = await w.claim(op);
    assert.equal(claim.json.code, "not_authorized");
    assert.equal(claim.json.details.reason, "owner_permission_lost");
  } finally {
    await w.fga.write([requester]);
  }
});

test("an owner approval never rides a session_mfa review session", async () => {
  const { op, ap } = await prepare({
    selfApproval: "owner",
    tier: {
      assurance: "session_mfa",
      max_age: 3600,
      factors: ["webauthn-platform", "webauthn-roaming"],
    },
  });
  // A plain session token without approval details is not enough for the owner.
  const token = await w.idp.mint({
    sub: PEOPLE.alice,
    orgId: ORG.northstar,
    mfa: true,
    claims: { amr: ["pwd", "mfa", "webauthn-platform"] },
  });
  const r = await w.call("POST", `/v1/approval-requests/${ap.id}/decisions`, {
    token,
    body: { decision: "approve", operationDigest: op.digest },
  });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  // Treated as a per-operation decision: the token must carry this approval and digest.
  assert.equal(r.json.details.reason, "challenge_not_bound_to_operation");
  assert.equal((await ownerDecides(op, ap)).status, 200);
});
