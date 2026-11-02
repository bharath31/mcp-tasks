import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type PolicyDocument } from "../../service/src/policies.js";
import {
  createWorld,
  CLIENTS,
  ORG,
  PEOPLE,
  type World,
} from "../helpers/world.js";

let w: World;
before(async () => {
  w = await createWorld();
});
after(async () => {
  await w.close();
});
const scope = `merchant:${ORG.northstar}/refunds`;
const lenient = `merchant:${ORG.northstar}/lenient`;
let seq = 0;
const body = (o: Record<string, unknown> = {}) => ({
  organizationId: ORG.northstar,
  resourceServer: scope,
  operationKey: `authz:${++seq}`,
  action: "refund:create",
  resource: "payment:authz",
  arguments: { amountMinor: 500 },
  approvalAssertion: "none",
  ...o,
});
function document(
  resourceServer: string,
  actions: string[],
  requester = "refund_request",
): PolicyDocument {
  return {
    resource_server: resourceServer,
    version: `authz-${++seq}`,
    unknown_action: "deny",
    actions: Object.fromEntries(
      actions.map((name) => [
        name,
        {
          arguments: {},
          approvers: { relation: "refund_approve", on: "organization" },
          requester_relation: requester,
          rules: [],
          default: { allow: {} },
        },
      ]),
    ),
    tiers: { routine: { assurance: "per_operation", max_age: 300 } },
  } as PolicyDocument;
}
async function publish(p: PolicyDocument) {
  const r = await w.call(
    "PUT",
    `/v1/policies/${encodeURIComponent(p.resource_server)}`,
    {
      token: await w.idp.service(CLIENTS.api, ["policies:write"]),
      body: { document: p, activate: true },
    },
  );
  assert.equal(r.status, 201, JSON.stringify(r.json));
}
const direct = async (b: Record<string, unknown>) =>
  w.call("POST", "/v1/operations", {
    token: await w.tok.api(),
    subject: await w.tok.user(PEOPLE.alice, ORG.northstar),
    body: b,
  });

test("a bare human token needs an explicit operations:register grant to register", async () => {
  const bare = await w.call("POST", "/v1/operations", {
    token: await w.tok.user(PEOPLE.alice, ORG.northstar),
    body: body(),
  });
  assert.equal(bare.status, 403, JSON.stringify(bare.json));
  assert.equal(bare.json.code, "not_authorized");
  const wrong = await w.call("POST", "/v1/operations", {
    token: await w.tok.user(PEOPLE.alice, ORG.northstar, {
      claims: { scope: "openid profile operations:read" },
    }),
    body: body(),
  });
  assert.equal(wrong.status, 403, JSON.stringify(wrong.json));
  for (const claims of [
    { scope: "openid operations:register" },
    { permissions: ["operations:register"] },
  ]) {
    const granted = await w.call("POST", "/v1/operations", {
      token: await w.tok.user(PEOPLE.alice, ORG.northstar, { claims }),
      body: body(),
    });
    assert.equal(granted.status, 200, JSON.stringify(granted.json));
    assert.equal(granted.json.delegationId, null);
  }
});

test("human-direct registration cannot pick a more lenient policy via resourceServer", async () => {
  await publish(document(lenient, ["refund:create"]));
  const denied = await direct(body({ resourceServer: lenient }));
  assert.equal(denied.status, 403, JSON.stringify(denied.json));
  assert.equal(denied.json.details.reason, "resource_server_not_allowed");
  const allowed = await direct(body());
  assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
});

test("human-direct registration needs an operator-configured action entry", async () => {
  // The tenant has no floor for this action, so its relations would be wholly caller-selected.
  await publish(document(scope, ["refund:create", "report:export"], "member"));
  const r = await direct(
    body({ action: "report:export", resource: "report:1" }),
  );
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.equal(r.json.details.reason, "action_not_configured");
});

test("delegated registration is unaffected by the human-direct rules", async () => {
  const d = await w.delegate();
  const r = await w.register(d.json.id, {
    assertion: "none",
    amountMinor: 500,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test("a cancelled step-up operation cannot be revived by a later caller step-up", async () => {
  const p = document(scope, ["refund:create"]);
  p.actions["refund:create"]!.default = {
    step_up: { acr: "mfa", max_age: 300 },
  };
  await publish(p);
  const request = body({ operationKey: "authz:revive" });
  const weak = await direct(request);
  assert.equal(
    weak.json.decision,
    "step_up_required",
    JSON.stringify(weak.json),
  );
  const cancelled = await w.call(
    "POST",
    `/v1/operations/${weak.json.id}/cancel`,
    {
      token: await w.tok.api(),
      body: {},
    },
  );
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  const strong = await w.call("POST", "/v1/operations", {
    token: await w.tok.api(),
    subject: await w.tok.user(PEOPLE.alice, ORG.northstar, { mfa: true }),
    body: request,
  });
  assert.equal(
    strong.json.decision,
    "step_up_required",
    JSON.stringify(strong.json),
  );
  assert.notEqual(strong.json.outcomeStatus, "approved");
  const row = await w.store.pool.query(
    "select status, decision from authority.operations where id=$1",
    [weak.json.id],
  );
  assert.deepEqual(row.rows[0], {
    status: "cancelled",
    decision: "step_up_required",
  });
});
