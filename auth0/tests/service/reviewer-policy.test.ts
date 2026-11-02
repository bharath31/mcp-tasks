import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  exportJWK,
  generateKeyPair,
  calculateJwkThumbprint,
  SignJWT,
} from "jose";
import {
  createWorld,
  ORG,
  PEOPLE,
  type World,
  BASE_URL,
} from "../helpers/world.js";
import { startCiba } from "../../service/src/ciba.js";

let w: World;
before(async () => {
  w = await createWorld();
});
after(async () => {
  await w.close();
});
const second = "auth0|reviewer-two";
const reviewer = () => w.tok.user(PEOPLE.morgan, ORG.northstar);
async function prepare(tier?: Record<string, unknown>, quorum = 1) {
  const { op, ap } = await w.exception();
  if (tier)
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
          assurance: tier,
          quorum,
        }),
      ],
    );
  return { op, ap };
}
async function dpopClient(claims: Record<string, unknown> = {}) {
  const keys = await generateKeyPair("ES256");
  const jwk = await exportJWK(keys.publicKey);
  const jkt = await calculateJwkThumbprint(jwk);
  let token = await w.idp.mint({
    sub: PEOPLE.morgan,
    orgId: ORG.northstar,
    mfa: true,
    claims: { cnf: { jkt }, ...claims },
  });
  const request = async (path: string, body?: unknown, jti = randomUUID()) => {
    const method = body === undefined ? "GET" : "POST";
    const url = `${BASE_URL}${path}`;
    const proof = await new SignJWT({
      htm: method,
      htu: url.split("?")[0],
      ath: createHash("sha256").update(token).digest("base64url"),
    })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk })
      .setIssuedAt(w.clock.seconds)
      .setJti(jti)
      .sign(keys.privateKey);
    const res = await w.handle(
      new Request(url, {
        method,
        headers: {
          authorization: `DPoP ${token}`,
          dpop: proof,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: res.status, json: (await res.json()) as any };
  };
  return {
    request,
    keys,
    jwk,
    jkt,
    token,
    async challengeToken(challenge: string) {
      token = await w.idp.mint({
        sub: PEOPLE.morgan,
        orgId: ORG.northstar,
        mfa: true,
        claims: {
          cnf: { jkt },
          "https://task-authority.example/approval_challenge": challenge,
        },
      });
    },
  };
}

test("queue and lease reread eligibility; concurrent reviewers cannot both lease", async () => {
  const { ap } = await prepare();
  await w.fga.write([
    {
      user: `user:${second}`,
      relation: "refund_approve",
      object: `organization:${ORG.northstar}`,
    },
  ]);
  const token = await reviewer();
  const other = await w.tok.user(second, ORG.northstar);
  const queue = await w.call("GET", "/v1/approval-requests?status=pending", {
    token,
  });
  assert.ok(queue.json.approvals.some((a: any) => a.id === ap.id));
  const leases = await Promise.all(
    [token, other].map((token) =>
      w.call("POST", `/v1/approval-requests/${ap.id}/lease`, {
        token,
        body: {},
      }),
    ),
  );
  assert.deepEqual(leases.map((x) => x.status).sort(), [200, 409]);
  const tuple = {
    user: `user:${PEOPLE.morgan}`,
    relation: "refund_approve",
    object: `organization:${ORG.northstar}`,
  };
  await w.fga.delete([tuple]);
  try {
    assert.deepEqual(
      (await w.call("GET", "/v1/approval-requests?status=pending", { token }))
        .json.approvals,
      [],
    );
    assert.equal(
      (
        await w.call("POST", `/v1/approval-requests/${ap.id}/lease`, {
          token,
          body: {},
        })
      ).status,
      403,
    );
  } finally {
    await w.fga.write([tuple]);
  }
});

test("routine tier reuses one MFA token across forty decisions; DPoP proof replay fails", async () => {
  const client = await dpopClient();
  for (let n = 0; n < 40; n++) {
    const { op, ap } = await prepare({
      assurance: "session_mfa",
      max_age: 3600,
      dpop: "required",
    });
    const r = await client.request(`/v1/approval-requests/${ap.id}/decisions`, {
      decision: "approve",
      operationDigest: op.digest,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const proofId = randomUUID();
  assert.equal(
    (
      await client.request(
        "/v1/approval-requests?status=pending",
        undefined,
        proofId,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await client.request(
        "/v1/approval-requests?status=pending",
        undefined,
        proofId,
      )
    ).status,
    401,
  );
});

test("routine tier rejects unbound bearer token and limits decision velocity", async () => {
  const { op, ap } = await prepare({
    assurance: "session_mfa",
    max_age: 3600,
    dpop: "required",
    velocity_per_hour: 1,
  });
  const bearer = await w.approve(ap.id, op.digest);
  assert.equal(bearer.json.details.reason, "dpop_required");
  const client = await dpopClient();
  const limited = await client.request(
    `/v1/approval-requests/${ap.id}/decisions`,
    { decision: "approve", operationDigest: op.digest },
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.json.details.reason, "reviewer_velocity_exceeded");
});

test("a bound batch is atomic when one digest is wrong", async () => {
  const a = await prepare(),
    b = await prepare();
  const token = await w.tok.user(PEOPLE.morgan, ORG.northstar, {
    mfa: true,
    details: [a, b].map((x) => ({
      type: "task_authority_approval",
      approval_id: x.ap.id,
      operation_digest:
        x.ap.id === b.ap.id ? "sha256:" + "0".repeat(64) : x.op.digest,
    })),
  });
  const r = await w.call("POST", "/v1/approval-requests/decisions", {
    token,
    body: {
      decisions: [
        {
          approvalId: a.ap.id,
          decision: "approve",
          operationDigest: a.op.digest,
        },
        {
          approvalId: b.ap.id,
          decision: "approve",
          operationDigest: "sha256:" + "0".repeat(64),
        },
      ],
    },
  });
  assert.equal(r.status, 409);
  const rows = await w.store.pool.query(
    "select status from authority.approvals where id=any($1)",
    [[a.ap.id, b.ap.id]],
  );
  assert.ok(rows.rows.every((x) => x.status === "pending"));
});

test("CIBA expiry explicitly derives the selected channel window", async () => {
  let received: URLSearchParams | undefined;
  await startCiba(
    {
      bcAuthorizeUrl: "https://idp.example/bc",
      tokenUrl: "https://idp.example/token",
      clientId: "test",
      clientSecret: "secret",
      audience: "api",
      issuer: "https://idp.example/",
      fetch: async (_url, init) => {
        received = new URLSearchParams(String(init?.body));
        return Response.json({ auth_req_id: "req1", expires_in: 1800 });
      },
    },
    { sub: "reviewer", message: "Review refund", requestedExpirySec: 1800 },
  );
  assert.equal(received?.get("requested_expiry"), "1800");
});

test("fresh fallback challenge binds one DPoP key and digest without RAR", async () => {
  const a = await prepare({ assurance: "per_operation" });
  const b = await prepare({ assurance: "per_operation" });
  const client = await dpopClient();
  const c = await client.request(
    `/v1/approval-requests/${a.ap.id}/challenge`,
    {},
  );
  assert.equal(c.status, 200, JSON.stringify(c.json));
  await client.challengeToken(c.json.challenge);
  const wrong = await client.request(
    `/v1/approval-requests/${b.ap.id}/decisions`,
    { decision: "approve", operationDigest: b.op.digest },
  );
  assert.equal(wrong.json.details.reason, "challenge_not_bound_to_operation");
  const right = await client.request(
    `/v1/approval-requests/${a.ap.id}/decisions`,
    { decision: "approve", operationDigest: a.op.digest },
  );
  assert.equal(right.status, 200, JSON.stringify(right.json));
  assert.equal(
    (
      await w.store.pool.query(
        "select used_at from authority.approval_challenges where challenge=$1",
        [c.json.challenge],
      )
    ).rows[0].used_at instanceof Date,
    true,
  );
});

test("quorum keeps operation pending until two distinct eligible reviewers approve", async () => {
  const { op, ap } = await prepare({ assurance: "per_operation" }, 2);
  const first = await w.approve(ap.id, op.digest);
  assert.equal(first.json.status, "pending", JSON.stringify(first.json));
  const again = await w.approve(ap.id, op.digest);
  assert.equal(again.json.status, "pending");
  assert.equal((await w.claim(op)).json.code, "approval_pending");
  const secondVote = await w.approve(ap.id, op.digest, { person: second });
  assert.equal(
    secondVote.json.status,
    "approved",
    JSON.stringify(secondVote.json),
  );
  assert.equal((await w.claim(op)).json.decision, "authorized");
});

test("successful batch consumes its token once for the complete set", async () => {
  const a = await prepare({ assurance: "per_operation", batch_max: 5 }),
    b = await prepare({ assurance: "per_operation", batch_max: 5 });
  const token = await w.tok.user(second, ORG.northstar, {
    mfa: true,
    details: [a, b].map((x) => ({
      type: "task_authority_approval",
      approval_id: x.ap.id,
      operation_digest: x.op.digest,
    })),
  });
  const body = {
    decisions: [a, b].map((x) => ({
      approvalId: x.ap.id,
      operationDigest: x.op.digest,
      decision: "approve",
    })),
  };
  const r = await w.call("POST", "/v1/approval-requests/decisions", {
    token,
    body,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.approvals.every((x: any) => x.status === "approved"));
  assert.equal(
    (await w.call("POST", "/v1/approval-requests/decisions", { token, body }))
      .status,
    403,
  );
});

test("a quorum whose first voter loses eligibility can be superseded before expiry", async () => {
  const { op, ap } = await prepare({ assurance: "per_operation" }, 2);
  await w.approve(ap.id, op.digest);
  await w.approve(ap.id, op.digest, { person: second });
  const tuple = {
    user: `user:${PEOPLE.morgan}`,
    relation: "refund_approve",
    object: `organization:${ORG.northstar}`,
  };
  await w.fga.delete([tuple]);
  try {
    assert.equal((await w.claim(op)).json.code, "approver_ineligible");
    const renewed = await w.requestApproval(op.id);
    assert.equal(renewed.status, 200, JSON.stringify(renewed.json));
    assert.notEqual(renewed.json.id, ap.id);
    assert.equal(renewed.json.status, "pending");
  } finally {
    await w.fga.write([tuple]);
  }
});

test("signed Action MFA claims supersede the older primary authentication time", async () => {
  const { op, ap } = await prepare({ assurance: "per_operation" });
  const token = await w.tok.user(PEOPLE.morgan, ORG.northstar, {
    authTime: w.clock.seconds - 7200,
    details: [
      {
        type: "task_authority_approval",
        approval_id: ap.id,
        operation_digest: op.digest,
      },
    ],
    claims: {
      amr: ["pwd"],
      "https://task-authority.example/amr": ["mfa"],
      "https://task-authority.example/auth_time": w.clock.seconds,
    },
  });
  const response = await w.call(
    "POST",
    `/v1/approval-requests/${ap.id}/decisions`,
    { token, body: { decision: "approve", operationDigest: op.digest } },
  );
  assert.equal(response.status, 200, JSON.stringify(response.json));
  const recorded = (
    await w.store.pool.query(
      "select assurance from authority.approvals where id=$1",
      [ap.id],
    )
  ).rows[0].assurance;
  assert.deepEqual(recorded.amr, ["pwd", "mfa"]);
  assert.equal(recorded.authTime, w.clock.seconds);
});

test("expired DPoP proof ids are pruned while live ones stay replay-protected", async () => {
  const client = await dpopClient();
  const old = randomUUID();
  const live = randomUUID();
  assert.equal(
    (
      await client.request(
        "/v1/approval-requests?status=pending",
        undefined,
        old,
      )
    ).status,
    200,
  );
  const count = async (jti: string) =>
    Number(
      (
        await w.store.pool.query(
          "select count(*) n from authority.used_dpop_proofs where jti=$1",
          [jti],
        )
      ).rows[0].n,
    );
  assert.equal(await count(old), 1);
  w.clock.advance(130_000);
  const fresh = await dpopClient();
  assert.equal(
    (
      await fresh.request(
        "/v1/approval-requests?status=pending",
        undefined,
        live,
      )
    ).status,
    200,
  );
  assert.equal(await count(old), 0);
  assert.equal(await count(live), 1);
  assert.equal(
    (
      await fresh.request(
        "/v1/approval-requests?status=pending",
        undefined,
        live,
      )
    ).status,
    401,
  );
});

test("a decision reads the reviewer's FGA eligibility exactly once", async () => {
  const { op, ap } = await prepare();
  w.fga.checks.length = 0;
  const res = await w.approve(ap.id, op.digest);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const mine = w.fga.checks.filter((c) =>
    c.startsWith(`user:${PEOPLE.morgan} refund_approve `),
  );
  assert.equal(mine.length, 1, mine.join("\n"));
});

test("tier factors are enforced against the token's amr and fail closed without factor evidence", async () => {
  const tier = {
    assurance: "per_operation",
    max_age: 300,
    factors: ["webauthn-roaming"],
  };
  const decide = async (amr: string[]) => {
    const { op, ap } = await prepare(tier);
    const token = await w.idp.mint({
      sub: PEOPLE.morgan,
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
      body: { decision: "approve", operationDigest: op.digest },
    });
  };
  // A bare "mfa" (or an otp) cannot prove a security-key factor.
  for (const amr of [
    ["pwd", "mfa"],
    ["pwd", "mfa", "otp"],
  ]) {
    const r = await decide(amr);
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal(r.json.details.reason, "factor_not_satisfied");
  }
  assert.equal((await decide(["pwd", "mfa", "webauthn-roaming"])).status, 200);
});

test("tier dpop optional admits a bearer session token; idle_timeout is policy-driven", async () => {
  const optional = await prepare({
    assurance: "session_mfa",
    max_age: 3600,
    dpop: "optional",
  });
  const bearer = await w.approve(optional.ap.id, optional.op.digest);
  assert.equal(bearer.status, 200, JSON.stringify(bearer.json));

  const tier = { assurance: "session_mfa", max_age: 3600, idle_timeout: "1m" };
  const client = await dpopClient();
  const first = await prepare(tier);
  assert.equal(
    (
      await client.request(`/v1/approval-requests/${first.ap.id}/decisions`, {
        decision: "approve",
        operationDigest: first.op.digest,
      })
    ).status,
    200,
  );
  w.clock.advance(90_000);
  const second = await prepare(tier);
  const idle = await client.request(
    `/v1/approval-requests/${second.ap.id}/decisions`,
    { decision: "approve", operationDigest: second.op.digest },
  );
  assert.equal(idle.status, 403, JSON.stringify(idle.json));
  assert.equal(idle.json.details.reason, "reviewer_session_idle");
});
