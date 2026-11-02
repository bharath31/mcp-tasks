import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startWorld, ORG, type World } from "./helpers/world.js";

let w: World;
let alice: string;
before(async () => {
  w = await startWorld();
  alice = await w.login("alice");
});
after(async () => w.close());

const scenario = (id: string, token = alice) =>
  w.call("POST", "/sandbox/scenario", token, { id });

describe("identity and sandbox lifecycle (real token verification)", () => {
  it("info is public, has no session endpoint and carries the banner", async () => {
    const r = await w.call("GET", "/sandbox/info");
    assert.equal(r.status, 200);
    assert.match(r.json.banner, /simulated payments/);
    assert.equal(r.json.paymentsMode, "simulator");
    assert.ok(!r.json.endpoints.some((e: string) => e.includes("session")));
    assert.equal(r.json.scenarios.length, 8);
  });
  it("rejects missing, garbage and foreign-org tokens with machine-readable reasons", async () => {
    const none = await w.call("GET", "/sandbox/me");
    assert.equal(none.status, 401);
    assert.equal(none.json.reason, "invalid_identity");
    assert.equal(none.json.nextAction, "sign_in");
    const bad = await w.call("GET", "/sandbox/me", "a.b.c");
    assert.equal(bad.status, 401);
    const agent = await w.call("GET", "/sandbox/me", await clientToken());
    assert.equal(agent.status, 403);
    assert.equal(agent.json.reason, "organization_required");
  });
  it("starts uninitialized, then reset creates the sandbox with real policy, delegation and orders", async () => {
    const me = await w.call("GET", "/sandbox/me", alice);
    assert.equal(me.json.initialized, false);
    assert.equal(
      (await w.call("GET", "/sandbox/state", alice)).json.reason,
      "sandbox_not_initialized",
    );
    const r = await w.call("POST", "/sandbox/reset", alice, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.generation, 1);
    assert.equal(r.json.policyVersion, "refunds.v1");
    assert.match(r.json.delegationId, /^dlg_/);
    assert.equal(r.json.orders.length, 6);
    const p = (await w.call("GET", "/sandbox/progress", alice)).json.progress;
    assert.equal(p.policyPublished, true);
    assert.equal(p.autoAllowedRefund, false);
  });
});

async function clientToken() {
  const res = await fetch(`${w.oidc.issuer}oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "agent",
      client_secret: "agt-s",
      audience: w.env.TASK_AUTHORITY_AUDIENCE!,
    }),
  });
  return ((await res.json()) as any).access_token as string;
}

describe("scenarios go through POST /v1/refunds with real decisions", () => {
  const expected: Array<[string, number, string, string?]> = [
    ["small_within_budget", 201, "allow"],
    ["routine_approval", 202, "approval_required"],
    ["high_value", 202, "approval_required"],
    ["unknown_action", 403, "deny"],
    ["assert_none", 202, "approval_required"],
    ["human_step_up", 401, "step_up_required"],
  ];
  for (const [id, status, decision] of expected)
    it(id, async () => {
      const r = await scenario(id);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(
        r.json.response.status,
        status,
        JSON.stringify(r.json.response.body),
      );
      assert.equal(r.json.decision, decision);
      assert.ok(r.json.reasonCode, "reason code present");
      if (status === 202) {
        assert.ok(r.json.response.headers.location);
        assert.ok(r.json.approvalId);
        assert.ok(r.json.cli && r.json.mcp);
      }
      if (status === 401)
        assert.match(
          r.json.response.headers["www-authenticate"],
          /insufficient_user_authentication/,
        );
    });

  it("reports distinct reason codes and tiers", async () => {
    const a = await scenario("routine_approval");
    const h = await scenario("high_value");
    assert.equal(a.json.response.body.operation.tier, "routine");
    assert.equal(h.json.response.body.operation.tier, "high_value");
    const u = await scenario("unknown_action");
    assert.ok(/unknown|action/.test(u.json.reasonCode), u.json.reasonCode);
    const n = await scenario("assert_none");
    assert.equal(n.json.response.body.operation.approvalRequirement, "human");
  });

  it("budget exhaustion ends in an approval requirement with the budget reason", async () => {
    const r = await scenario("budget_exhausted");
    assert.equal(r.status, 200);
    assert.ok(r.json.steps.length >= 2);
    assert.equal(r.json.steps[0].status, 201);
    assert.equal(r.json.response.status, 202);
    assert.equal(r.json.explain.reason, "budget_exhausted");
    assert.deepEqual(r.json.response.body.ruleIds, ["default"]);
  });

  it("self approval scenario: request is hidden from your own queue", async () => {
    const r = await scenario("self_approval");
    assert.equal(r.json.response.status, 202);
    assert.equal(r.json.steps[1].reasonCode, "own_request_hidden_from_queue");
  });

  it("the service refuses a requester approving their own routine request", async () => {
    const created = await w.call("POST", "/v1/refunds", alice, {
      orderId: await anyOrder(),
      amountMinor: 15000,
      approvalAssertion: "human",
    });
    assert.equal(created.status, 202, JSON.stringify(created.json));
    assert.equal(created.json.operation.tier, "routine");
    const rev = await w.reviewer("alice");
    const d = await rev.post(
      `/v1/approval-requests/${created.json.operation.approvalId}/decisions`,
      {
        decision: "approve",
        operationDigest: created.json.operation.digest,
      },
    );
    assert.equal(d.status, 403);
    assert.equal(d.json.details?.reason, "initiator_cannot_approve");
  });
});

async function anyOrder() {
  return (await w.call("GET", "/sandbox/orders", alice)).json.orders[0]
    .orderId as string;
}
