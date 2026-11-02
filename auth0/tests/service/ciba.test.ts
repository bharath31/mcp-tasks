// CIBA approval channel, tested against a LOCAL standards-shaped provider (not Auth0).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  startOidcServer,
  type OidcServer,
  type OidcUser,
} from "../helpers/oidc-server.js";
import { ORG, PEOPLE, createWorld, type World } from "../helpers/world.js";

let w: World;
let oidc: OidcServer;
before(async () => {
  oidc = await startOidcServer({
    users: ([PEOPLE.morgan, PEOPLE.eve, PEOPLE.alice] as string[])
      .map((sub): OidcUser => ({
        key: sub,
        sub,
        name: sub,
        org: ORG.northstar,
      }))
      .concat([
        {
          key: PEOPLE.mallory,
          sub: PEOPLE.mallory,
          name: "mallory",
          org: ORG.southridge,
        },
      ]),
    clients: [{ id: "authority-ciba", secret: "ciba-secret" }],
    resourceAudiences: ["https://task-authority.example/api"],
  });
  w = await createWorld({ oidc });
  w.tenant.ciba = {
    bcAuthorizeUrl: `${oidc.issuer}bc-authorize`,
    tokenUrl: `${oidc.issuer}oauth/token`,
    clientId: "authority-ciba",
    clientSecret: "ciba-secret",
    audience: w.idp.audience,
    issuer: oidc.issuer,
  };
});
after(async () => {
  await w.close();
  await oidc.close();
});

async function cibaCall(
  method: "GET" | "POST",
  path: string,
  options: Parameters<World["call"]>[2] = {},
) {
  const body = options?.body as
    { channel?: string; reviewerSubject?: string } | undefined;
  if (
    method === "POST" &&
    body?.channel === "ciba" &&
    path.endsWith("/approval-requests")
  ) {
    const portal = await w.call(method, path, { ...options, body: {} });
    if (portal.status !== 200) return portal;
    return w.call("POST", `/v1/approval-requests/${portal.json.id}/escalate`, {
      ...options,
      body: { reviewerSubject: body.reviewerSubject },
    });
  }
  return w.call(method, path, options);
}

const claimRows = async (opId: string) =>
  (
    await w.store.pool.query(
      "select status from authority.claims where operation_id=$1",
      [opId],
    )
  ).rows;

async function cibaApproval(reviewer: string) {
  const d = (await w.delegate()).json;
  const op = (await w.register(d.id, { amountMinor: 15000 })).json;
  const ap = await cibaCall(
    "POST",
    `/v1/operations/${op.id}/approval-requests`,
    {
      token: await w.tok.api(),
      body: {
        permission: "refund_approve",
        channel: "ciba",
        reviewerSubject: reviewer,
      },
    },
  );
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  const authReqId = (
    await w.store.pool.query(
      "select ciba_auth_req_id from authority.approvals where id=$1",
      [ap.json.id],
    )
  ).rows[0].ciba_auth_req_id as string;
  return { d, op, ap: ap.json, authReqId };
}
const poll = async (id: string) =>
  cibaCall("POST", `/v1/approval-requests/${id}/ciba/poll`, {
    token: await w.tok.api(),
    body: {},
  });

describe("CIBA/RAR approval channel (FR-023, against a local provider)", () => {
  test("the service starts the backchannel request, binds approval id + digest, and records the approved decision after verifying it like any other", async () => {
    const { op, ap, authReqId } = await cibaApproval(PEOPLE.morgan);
    assert.equal(ap.method, "ciba_rar");
    assert.equal(ap.status, "pending");
    const request = oidc.cibaRequests.get(authReqId)!;
    assert.deepEqual(request.details, [
      {
        type: "task_authority_approval",
        approval_id: ap.id,
        operation_digest: op.digest,
      },
    ]);
    assert.match(request.message, /refund:create/);
    assert.equal((await w.claim(op)).json.code, "approval_pending");

    assert.equal((await poll(ap.id)).json.polled, "pending");
    oidc.cibaDecide(authReqId, true);
    const done = await poll(ap.id);
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.polled, "approved");
    assert.equal(done.json.method, "ciba_rar");
    // Idempotent: polling again returns the recorded decision without another provider call.
    assert.equal((await poll(ap.id)).json.polled, "approved");
    assert.equal((await w.claim(op)).json.decision, "authorized");
    const audit = await w.audit(op.id);
    const approved = audit.find((e) => e.type === "approval.approved")!;
    assert.equal(approved.actor.id, PEOPLE.morgan);
    const evalRow = (
      await w.store.pool.query(
        "select evaluation from authority.audit_events where type='approval.approved' and operation_id=$1",
        [op.id],
      )
    ).rows[0].evaluation;
    assert.equal(evalRow.method, "ciba_rar");
    assert.equal(evalRow.assurance.boundTo, "approval+digest");
  });

  test("a reviewer's denial is recorded and final", async () => {
    const { op, ap, authReqId } = await cibaApproval(PEOPLE.morgan);
    oidc.cibaDecide(authReqId, false);
    const r = await poll(ap.id);
    assert.equal(r.json.polled, "rejected");
    assert.equal((await w.claim(op)).json.code, "approval_rejected");
    assert.equal((await claimRows(op.id)).length, 0);
    const row = (
      await w.store.pool.query(
        "select approver_id,reviewer_hint,assurance from authority.approvals where id=$1",
        [ap.id],
      )
    ).rows[0];
    assert.equal(row.approver_id, null);
    assert.equal(row.reviewer_hint, PEOPLE.morgan);
    assert.equal(row.assurance.via, "ciba_denied");
    const event = (await w.audit(op.id)).find(
      (e) => e.type === "approval.rejected",
    )!;
    assert.equal(event.actor.id, "ciba-provider");
  });

  test("an approval by someone who is not an eligible approver is refused and authorizes nothing (Eve)", async () => {
    const { op, ap, authReqId } = await cibaApproval(PEOPLE.eve);
    oidc.cibaDecide(authReqId, true);
    const r = await poll(ap.id);
    assert.equal(r.json.code, "approver_ineligible");
    assert.equal((await w.claim(op)).json.code, "approval_pending");
  });

  test("the initiator cannot approve through CIBA either, and a wrong-organization approver is refused", async () => {
    const own = await cibaApproval(PEOPLE.alice);
    oidc.cibaDecide(own.authReqId, true);
    assert.equal((await poll(own.ap.id)).json.code, "approver_ineligible");
    const far = await cibaApproval(PEOPLE.mallory);
    oidc.cibaDecide(far.authReqId, true);
    const r = await poll(far.ap.id);
    assert.equal(r.json.code, "not_authorized");
    assert.equal((await w.claim(far.op)).json.code, "approval_pending");
  });

  test("assurance is enforced: a CIBA result without multi-factor is not an approval", async () => {
    const { op, ap, authReqId } = await cibaApproval(PEOPLE.morgan);
    oidc.cibaDecide(authReqId, true, false);
    const r = await poll(ap.id);
    assert.equal(r.json.code, "not_authorized");
    assert.equal(r.json.details.reason, "mfa_required");
    assert.equal((await w.claim(op)).json.code, "approval_pending");
  });

  test("provider succeeded but the service could not finish recording: the orphaned grant authorizes nothing and recovery is a fresh request", async () => {
    const { d, op, ap, authReqId } = await cibaApproval(PEOPLE.morgan);
    oidc.cibaDecide(authReqId, true);
    // Eligibility cannot be verified at the moment the token arrives (the provider already released it).
    w.fga.gate = async (c) => {
      if (c.includes(`user:${PEOPLE.morgan} refund_approve`))
        throw new Error("fga down (injected)");
    };
    try {
      const r = await poll(ap.id);
      assert.equal(r.json.code, "authorization_unavailable");
    } finally {
      w.fga.gate = null;
    }
    assert.equal(
      (
        await w.store.pool.query(
          "select status from authority.approvals where id=$1",
          [ap.id],
        )
      ).rows[0].status,
      "pending",
    );
    assert.equal((await w.claim(op)).json.code, "approval_pending");
    // The provider released that token exactly once; it is gone, so the approval can only expire.
    assert.equal((await poll(ap.id)).json.polled, "expired");
    assert.equal((await w.claim(op)).json.code, "approval_expired");
    assert.equal((await claimRows(op.id)).length, 0);
    // Recovery: ask again; this time it completes, once.
    const again = await cibaCall(
      "POST",
      `/v1/operations/${op.id}/approval-requests`,
      {
        token: await w.tok.api(),
        body: {
          permission: "refund_approve",
          channel: "ciba",
          reviewerSubject: PEOPLE.morgan,
        },
      },
    );
    assert.notEqual(again.json.id, ap.id);
    const req2 = (
      await w.store.pool.query(
        "select ciba_auth_req_id from authority.approvals where id=$1",
        [again.json.id],
      )
    ).rows[0].ciba_auth_req_id;
    oidc.cibaDecide(req2, true);
    assert.equal((await poll(again.json.id)).json.polled, "approved");
    assert.equal((await w.claim(op)).json.decision, "authorized");
    void d;
  });

  test("if the provider cannot be reached the intent is closed: nothing is left pending and the caller gets a retryable error", async () => {
    const saved = w.tenant.ciba!;
    w.tenant.ciba = {
      ...saved,
      bcAuthorizeUrl: "https://localhost:9/bc-authorize",
    };
    try {
      const d = (await w.delegate()).json;
      const op = (await w.register(d.id, { amountMinor: 15000 })).json;
      const r = await cibaCall(
        "POST",
        `/v1/operations/${op.id}/approval-requests`,
        {
          token: await w.tok.api(),
          body: { channel: "ciba", reviewerSubject: PEOPLE.morgan },
        },
      );
      assert.equal(r.status, 503);
      assert.equal(r.json.code, "authorization_unavailable");
      assert.equal(r.json.retryable, true);
      assert.equal(
        (
          await w.store.pool.query(
            "select count(*) n from authority.approvals where operation_id=$1 and status='pending' and method='ciba_rar'",
            [op.id],
          )
        ).rows[0].n,
        "0",
      );
      // The portal approval is superseded only once CIBA has started: it is still the live one.
      const live = await w.store.pool.query(
        "select method,status from authority.approvals where operation_id=$1 and status in ('pending','approved')",
        [op.id],
      );
      assert.deepEqual(live.rows, [
        { method: "portal_stepup", status: "pending" },
      ]);
      assert.equal((await w.claim(op)).json.code, "approval_pending");
      assert.ok(
        (await w.audit(op.id)).some(
          (e) => e.reasonCode === "ciba_initiation_failed",
        ),
      );
    } finally {
      w.tenant.ciba = saved;
    }
  });

  test("CIBA needs a reviewer subject and a configured provider; polling needs the trusted backend", async () => {
    const d = (await w.delegate()).json;
    const op = (await w.register(d.id, { amountMinor: 15000 })).json;
    const noSubject = await cibaCall(
      "POST",
      `/v1/operations/${op.id}/approval-requests`,
      { token: await w.tok.api(), body: { channel: "ciba" } },
    );
    assert.equal(noSubject.json.code, "invalid_request");
    const ap = await cibaCall(
      "POST",
      `/v1/operations/${op.id}/approval-requests`,
      {
        token: await w.tok.api(),
        body: { channel: "ciba", reviewerSubject: PEOPLE.morgan },
      },
    );
    for (const token of [
      await w.tok.executor(),
      await w.tok.user(PEOPLE.morgan, ORG.northstar),
    ])
      assert.equal(
        (
          await cibaCall(
            "POST",
            `/v1/approval-requests/${ap.json.id}/ciba/poll`,
            { token, body: {} },
          )
        ).json.code,
        "not_authorized",
      );
    const saved = w.tenant.ciba;
    w.tenant.ciba = undefined;
    try {
      const d2 = (await w.delegate()).json;
      const op2 = (await w.register(d2.id, { amountMinor: 15000 })).json;
      assert.equal(
        (
          await cibaCall("POST", `/v1/operations/${op2.id}/approval-requests`, {
            token: await w.tok.api(),
            body: { channel: "ciba", reviewerSubject: PEOPLE.morgan },
          })
        ).json.code,
        "invalid_request",
      );
    } finally {
      w.tenant.ciba = saved;
    }
  });
});

describe("CIBA without RAR (opt-in, for providers that cannot do authorization_details)", () => {
  let saved: typeof w.tenant.ciba;
  before(() => {
    saved = w.tenant.ciba;
    w.tenant.ciba = { ...saved!, rar: false };
  });
  after(() => {
    w.tenant.ciba = saved;
  });

  test("the request carries no authorization_details; the server-held request id is the binding and the device approval is the second factor, recorded as such", async () => {
    const { op, ap, authReqId } = await cibaApproval(PEOPLE.morgan);
    const request = oidc.cibaRequests.get(authReqId)!;
    assert.deepEqual(request.details ?? [], []);
    // A token with no MFA claim and no bound details is acceptable here, and only here.
    oidc.cibaDecide(authReqId, true, false);
    const done = await poll(ap.id);
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.polled, "approved");
    const row = (
      await w.store.pool.query(
        "select assurance, decision_jti from authority.approvals where id=$1",
        [ap.id],
      )
    ).rows[0];
    assert.equal(row.assurance.boundTo, "ciba_request_id");
    assert.equal(row.assurance.attestedBy, "ciba_device_approval");
    assert.equal(row.decision_jti, `ciba:${authReqId}`);
    assert.equal((await w.claim(op)).json.decision, "authorized");
  });

  test("everything that is not the token claims still applies: eligibility, separation of duties, organization, expiry", async () => {
    const eve = await cibaApproval(PEOPLE.eve);
    oidc.cibaDecide(eve.authReqId, true, false);
    assert.equal((await poll(eve.ap.id)).json.code, "approver_ineligible");
    const own = await cibaApproval(PEOPLE.alice);
    oidc.cibaDecide(own.authReqId, true, false);
    assert.equal((await poll(own.ap.id)).json.code, "approver_ineligible");
    const far = await cibaApproval(PEOPLE.mallory);
    oidc.cibaDecide(far.authReqId, true, false);
    assert.equal((await poll(far.ap.id)).json.code, "not_authorized");
    const rej = await cibaApproval(PEOPLE.morgan);
    oidc.cibaDecide(rej.authReqId, false);
    assert.equal((await poll(rej.ap.id)).json.polled, "rejected");
  });

  test("the portal channel is unaffected: a decision without bound details is still refused", async () => {
    const d = (await w.delegate()).json;
    const op = (await w.register(d.id, { amountMinor: 15000 })).json;
    const ap = await cibaCall(
      "POST",
      `/v1/operations/${op.id}/approval-requests`,
      {
        token: await w.tok.api(),
        body: { permission: "refund_approve" },
      },
    );
    const r = await cibaCall(
      "POST",
      `/v1/approval-requests/${ap.json.id}/decisions`,
      {
        token: await w.tok.user(PEOPLE.morgan, ORG.northstar),
        body: { decision: "approve", operationDigest: op.digest },
      },
    );
    assert.equal(r.json.code, "not_authorized");
  });
});
