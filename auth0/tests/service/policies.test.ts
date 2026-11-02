import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  applyRequirementFloor,
  compileCondition,
  conditionCacheStats,
  evaluateCondition,
  evaluatePolicy,
  POLICY_TEMPLATES,
  validatePolicy,
  type PolicyDocument,
} from "../../service/src/policies.js";
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
function document(version: string): PolicyDocument {
  return {
    resource_server: scope,
    version,
    unknown_action: "deny",
    actions: {
      "refund:create": {
        arguments: { amountMinor: "int" },
        approvers: { relation: "refund_approve", on: "organization" },
        requester_relation: "refund_request",
        rules: [
          {
            id: "small",
            when: 'actor.type == "agent" && args.amountMinor <= 10000',
            then: {
              allow: {
                budget: {
                  per: "organization",
                  window: "24h",
                  max_amount_minor: 10000,
                  max_count: 1,
                },
              },
            },
          },
        ],
        default: { approve: { tier: "routine" } },
      },
    },
    tiers: {
      routine: { assurance: "per_operation", max_age: 300 },
      high_value: { assurance: "per_operation", batch_max: 5 },
    },
  };
}
async function apply(p: PolicyDocument, activate = true, shadow = false) {
  const token = await w.idp.service(CLIENTS.api, [
    "policies:write",
    "policies:read",
  ]);
  const r = await w.call("PUT", `/v1/policies/${encodeURIComponent(scope)}`, {
    token,
    body: { document: p, activate, shadow },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r;
}

test("constrained CEL rejects undeclared arguments, non-booleans, calls and incompatible types", () => {
  for (const source of [
    "args.unknown > 1",
    "args.amountMinor",
    'args.amountMinor.startsWith("1")',
    'args.amountMinor > "10"',
    'args.amountMinor == "foo"',
    'transport == "rest"',
    "args.constructor == 1",
  ])
    assert.throws(
      () => compileCondition(source, { amountMinor: "int" }),
      source,
    );
  const c = compileCondition(
    'actor.type == "agent" && args.amountMinor <= 10000 && args.currency in ["USD", "EUR"]',
    { amountMinor: "int", currency: "string" },
  );
  assert.equal(
    evaluateCondition(c, {
      actor: { type: "agent" },
      args: { amountMinor: 500, currency: "USD" },
    }),
    true,
  );
  assert.throws(() =>
    evaluateCondition(c, {
      actor: { type: "agent" },
      args: { amountMinor: 500 },
    }),
  );
});
test("policy validation rejects missing tiers, duplicate rules and undefined unknown-action tier", () => {
  const p = document("validate");
  p.actions["refund:create"]!.default = { approve: { tier: "missing" } };
  assert.throws(() => validatePolicy(p));
  const q = document("duplicate");
  q.actions["refund:create"]!.rules.push(q.actions["refund:create"]!.rules[0]!);
  assert.throws(() => validatePolicy(q));
  const r = document("unknown");
  r.unknown_action = "approve";
  delete r.tiers.routine;
  assert.throws(() => validatePolicy(r));
  for (const template of Object.values(POLICY_TEMPLATES))
    assert.doesNotThrow(() => validatePolicy(template));
});
test("strictest matching rule wins and evaluation errors deny", () => {
  const p = document("combine");
  p.actions["refund:create"]!.rules = [
    { id: "allow", when: "true", then: { allow: {} } },
    {
      id: "routine",
      when: "true",
      then: { approve: { tier: "routine", quorum: 2 } },
    },
    { id: "strong", when: "true", then: { approve: { tier: "high_value" } } },
  ];
  const result = evaluatePolicy(p, "refund:create", {
    args: { amountMinor: 100 },
    actor: { type: "agent" },
  });
  assert.equal(result.decision, "approval_required");
  assert.equal(result.quorum, 2);
  assert.deepEqual(result.ruleIds, ["allow", "routine", "strong"]);
  p.actions["refund:create"]!.rules.push({
    id: "deny",
    when: "true",
    then: { deny: { reason: "blocked" } },
  });
  assert.equal(
    evaluatePolicy(p, "refund:create", { args: { amountMinor: 100 } }).decision,
    "deny",
  );
  p.actions["refund:create"]!.rules = [
    { id: "missing-fact", when: "facts.balance > 0", then: { allow: {} } },
  ];
  assert.equal(
    evaluatePolicy(p, "refund:create", {
      args: { amountMinor: 100 },
      facts: {},
    }).reasonCode,
    "policy_evaluation_error",
  );
  assert.equal(evaluatePolicy(null, "refund:create", {}).decision, "deny");
  assert.equal(evaluatePolicy(p, "unknown", {}).reasonCode, "unknown_action");
});
test("caller cannot lower service requirement; audit binds facts, actor and immutable version", async () => {
  const p = document("raise-only");
  p.actions["refund:create"]!.rules = [];
  await apply(p);
  const d = (await w.delegate()).json;
  const registered = await w.register(d.id, {
    key: "policy:raise",
    amountMinor: 500,
    assertion: "none",
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  assert.equal(registered.json.approvalRequirement, "human");
  assert.equal(registered.json.decision, "approval_required");
  assert.equal(registered.json.policyVersion, p.version);
  const event = (await w.audit(registered.json.id)).find(
    (e) => e.type === "operation.registered",
  ) as any;
  assert.equal(event.evaluation.policyVersion, p.version);
  assert.deepEqual(event.evaluation.ruleIds, ["default"]);
  assert.equal(event.evaluation.actor.type, "agent");
  assert.deepEqual(event.evaluation.facts, {});
  const newer = document("raise-next");
  await apply(newer);
  const repeat = await w.register(d.id, {
    key: "policy:raise",
    amountMinor: 500,
    assertion: "none",
  });
  assert.equal(repeat.json.policyVersion, p.version);
  const token = await w.idp.service(CLIENTS.api, ["policies:write"]);
  const conflict = await w.call(
    "PUT",
    `/v1/policies/${encodeURIComponent(scope)}`,
    { token, body: { document: p, activate: true } },
  );
  assert.equal(conflict.status, 409);
  await assert.rejects(
    () =>
      w.store.pool.query(
        "update authority.policy_versions set document='{}' where tenant_id=$1 and version=$2",
        [w.tenant.tenantId, p.version],
      ),
    /append-only/,
  );
});
test("atomic registration reservations prevent budget races and not_submitted releases captured capacity", async () => {
  await apply(document("budget-race"));
  const d = (await w.delegate()).json;
  const registrations = await Promise.all([
    w.register(d.id, {
      key: "budget:a",
      amountMinor: 10000,
      assertion: "none",
    }),
    w.register(d.id, {
      key: "budget:b",
      amountMinor: 10000,
      assertion: "none",
    }),
  ]);
  assert.ok(
    registrations.every((r) => r.status === 200),
    JSON.stringify(registrations),
  );
  assert.deepEqual(registrations.map((r) => r.json.decision).sort(), [
    "allow",
    "approval_required",
  ]);
  const allowed = registrations.find((r) => r.json.decision === "allow")!.json;
  const holds = await w.store.pool.query(
    "select status from authority.policy_budget_consumption where operation_id=$1",
    [allowed.id],
  );
  assert.equal(holds.rows[0].status, "held");
  const claimed = await w.claim(allowed);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
  const captured = await w.store.pool.query(
    "select status from authority.policy_budget_consumption where operation_id=$1",
    [allowed.id],
  );
  assert.equal(captured.rows[0].status, "captured");
  const released = await w.outcome(
    allowed.id,
    claimed.json.claimId,
    "not_submitted",
  );
  assert.equal(released.status, 200);
  const next = await w.register(d.id, {
    key: "budget:c",
    amountMinor: 10000,
    assertion: "none",
  });
  assert.equal(next.json.decision, "allow");
});
test("lapsed reservation re-decides before dispatch and unknown outcome retains budget", async () => {
  const p = document("budget-expiry");
  p.budget_hold_ttl = "1s";
  p.actions["refund:create"]!.rules[0]!.id = "expiry-small";
  await apply(p);
  const d = (await w.delegate()).json;
  const a = (
    await w.register(d.id, {
      key: "expiry:a",
      amountMinor: 10000,
      assertion: "none",
    })
  ).json;
  assert.equal(a.decision, "allow");
  w.clock.advance(2000);
  const b = (
    await w.register(d.id, {
      key: "expiry:b",
      amountMinor: 10000,
      assertion: "none",
    })
  ).json;
  assert.equal(b.decision, "allow");
  const denied = await w.claim(a);
  assert.equal(
    denied.json.code,
    "budget_exhausted",
    JSON.stringify(denied.json),
  );
  const current = await w.call("GET", `/v1/operations/${a.id}`, {
    token: await w.tok.api(),
  });
  assert.equal(current.json.decision, "approval_required");
  const c = await w.claim(b);
  assert.equal(c.status, 200);
  await w.outcome(b.id, c.json.claimId, "unknown");
  w.clock.advance(2000);
  const next = await w.register(d.id, {
    key: "expiry:c",
    amountMinor: 10000,
    assertion: "none",
  });
  assert.equal(next.json.decision, "approval_required");
});
test("human-direct operation has verified human initiator and no delegation", async () => {
  const p = document("human-direct");
  p.actions["refund:create"]!.rules = [];
  await apply(p);
  const result = await w.call("POST", "/v1/operations", {
    token: await w.tok.api(),
    subject: await w.tok.user(PEOPLE.alice, ORG.northstar),
    body: {
      organizationId: ORG.northstar,
      resourceServer: scope,
      operationKey: "direct:human",
      action: "refund:create",
      resource: "payment:direct",
      arguments: { amountMinor: 500 },
      facts: { reason: "duplicate" },
      approvalAssertion: "none",
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.delegationId, null);
  assert.equal(result.json.actor.type, "human");
  const request = await w.requestApproval(result.json.id);
  assert.equal(request.status, 200, JSON.stringify(request.json));
  const self = await w.approve(request.json.id, result.json.digest, {
    person: PEOPLE.alice,
  });
  assert.equal(self.status, 403);
});
test("shadow evaluation logs without enforcement and simulation replays recorded facts", async () => {
  const active = document("shadow-live");
  active.actions["refund:create"]!.rules = [];
  await apply(active);
  const shadow = document("shadow-candidate");
  shadow.actions["refund:create"]!.rules = [
    {
      id: "all-denied",
      when: "true",
      then: { deny: { reason: "shadow-block" } },
    },
  ];
  await apply(shadow, false, true);
  const d = (await w.delegate()).json;
  const op = (
    await w.register(d.id, {
      key: "shadow:one",
      amountMinor: 200,
      assertion: "none",
    })
  ).json;
  assert.equal(op.decision, "approval_required");
  const rows = await w.store.pool.query(
    "select evaluation from authority.audit_events where operation_id=$1 and type='policy.shadow_evaluated'",
    [op.id],
  );
  assert.equal(rows.rows[0].evaluation.decision, "deny");
  const token = await w.idp.service(CLIENTS.api, ["policies:write"]);
  const simulated = await w.call(
    "POST",
    `/v1/policies/${encodeURIComponent(scope)}/simulate`,
    { token, body: { version: shadow.version, since: "30d" } },
  );
  assert.equal(simulated.status, 200, JSON.stringify(simulated.json));
  assert.ok(simulated.json.counts.outcomes.deny > 0);
  assert.ok(simulated.json.changed.some((c: any) => c.operationId === op.id));
});

test("caller step-up retries keep the pinned version and reject future or weaker assurance", async () => {
  const p = document("stepup-original");
  p.actions["refund:create"]!.rules = [];
  p.actions["refund:create"]!.default = {
    step_up: { acr: "mfa", max_age: 300 },
  };
  await apply(p);
  const body = {
    organizationId: ORG.northstar,
    resourceServer: scope,
    operationKey: "stepup:retry",
    action: "refund:create",
    resource: "payment:stepup",
    arguments: { amountMinor: 500 },
    approvalAssertion: "none",
  };
  const weak = await w.call("POST", "/v1/operations", {
    token: await w.tok.api(),
    subject: await w.tok.user(PEOPLE.alice, ORG.northstar),
    body,
  });
  assert.equal(weak.json.decision, "step_up_required");
  // Awaiting caller step-up is its own public outcome, never "approved".
  assert.equal(weak.json.outcomeStatus, "step_up_required");
  const seen = await w.call("GET", `/v1/operations/${weak.json.id}`, {
    token: await w.tok.api(),
  });
  assert.equal(seen.json.status, "step_up_required");
  assert.equal(seen.json.lifecycleStatus, "registered");
  const future = await w.call("POST", "/v1/operations", {
    token: await w.tok.api(),
    subject: await w.tok.user(PEOPLE.alice, ORG.northstar, {
      mfa: true,
      authTime: w.clock.seconds + 3600,
    }),
    body,
  });
  assert.equal(future.json.decision, "step_up_required");
  const replacement = document("stepup-replacement");
  replacement.actions["refund:create"]!.default = { deny: true };
  replacement.actions["refund:create"]!.rules = [];
  await apply(replacement);
  const strong = await w.call("POST", "/v1/operations", {
    token: await w.tok.api(),
    subject: await w.tok.user(PEOPLE.alice, ORG.northstar, { mfa: true }),
    body,
  });
  assert.equal(strong.json.decision, "allow", JSON.stringify(strong.json));
  assert.equal(strong.json.id, weak.json.id);
  assert.equal(strong.json.policyVersion, p.version);
  const custom = document("stepup-custom");
  custom.actions["refund:create"]!.rules = [];
  custom.actions["refund:create"]!.default = {
    step_up: { acr: "phishing-resistant", max_age: 300 },
  };
  await apply(custom);
  const weaker = await w.call("POST", "/v1/operations", {
    token: await w.tok.api(),
    subject: await w.tok.user(PEOPLE.alice, ORG.northstar, { mfa: true }),
    body: { ...body, operationKey: "stepup:custom" },
  });
  assert.equal(weaker.json.decision, "step_up_required");
});

test("unknown provider outcome retains captured budget beyond the rolling window", async () => {
  const p = document("unknown-retention");
  p.actions["refund:create"]!.rules[0]!.id = "unknown-retention-rule";
  p.actions["refund:create"]!.rules[0]!.then = {
    allow: { budget: { per: "organization", window: "1s", max_count: 1 } },
  };
  await apply(p);
  const d = (await w.delegate()).json;
  const op = (
    await w.register(d.id, {
      key: "unknown:first",
      amountMinor: 500,
      assertion: "none",
    })
  ).json;
  const claim = await w.claim(op);
  assert.equal(claim.status, 200);
  await w.outcome(op.id, claim.json.claimId, "unknown");
  w.clock.advance(2000);
  const next = await w.register(d.id, {
    key: "unknown:second",
    amountMinor: 500,
    assertion: "none",
  });
  assert.equal(next.json.decision, "approval_required");
  await w.outcome(op.id, claim.json.claimId, "not_submitted");
  const released = await w.register(d.id, {
    key: "unknown:third",
    amountMinor: 500,
    assertion: "none",
  });
  assert.equal(released.json.decision, "allow");
});
test("human direct operation key cannot be replayed by another verified principal", async () => {
  const p = document("actor-replay");
  p.actions["refund:create"]!.rules = [];
  await apply(p);
  const body = {
    organizationId: ORG.northstar,
    resourceServer: scope,
    operationKey: "direct:actor-bound",
    action: "refund:create",
    resource: "payment:private",
    arguments: { amountMinor: 500 },
  };
  const first = await w.call("POST", "/v1/operations", {
    token: await w.tok.api(),
    subject: await w.tok.user(PEOPLE.alice, ORG.northstar),
    body,
  });
  assert.equal(first.status, 200);
  const other = await w.call("POST", "/v1/operations", {
    token: await w.tok.api(),
    subject: await w.tok.user(PEOPLE.morgan, ORG.northstar),
    body,
  });
  assert.equal(other.status, 403);
  assert.equal(other.json.code, "not_authorized");
});

test("untouched expired operations free registration holds before the default hold TTL", async () => {
  const p = document("operation-expiry");
  p.actions["refund:create"]!.rules[0]!.id = "operation-expiry-rule";
  await apply(p);
  const d = (await w.delegate()).json;
  const first = await w.call("POST", "/v1/operations", {
    token: await w.tok.api(),
    subject: await w.tok.user(PEOPLE.alice, ORG.northstar),
    body: {
      delegationId: d.id,
      operationKey: "expiry:untouched",
      action: "refund:create",
      resource: "payment:expiry",
      arguments: { amountMinor: 500 },
      approvalAssertion: "none",
      expiresAt: w.iso(1000),
    },
  });
  assert.equal(first.json.decision, "allow");
  const stored = await w.store.pool.query(
    "select hold_expires_at from authority.policy_budget_consumption where operation_id=$1",
    [first.json.id],
  );
  assert.equal(
    stored.rows[0].hold_expires_at.toISOString(),
    first.json.expiresAt,
  );
  w.clock.advance(2000);
  const next = await w.register(d.id, {
    key: "expiry:untouched-next",
    amountMinor: 500,
    assertion: "none",
  });
  assert.equal(next.json.decision, "allow");
});
test("simulation and shadow include caller assertions and operator approval floors", async () => {
  const live = document("effective-live");
  live.actions["refund:create"]!.rules = [];
  live.actions["refund:create"]!.default = { allow: {} };
  await apply(live);
  const candidate = { ...live, version: "effective-candidate" };
  await apply(candidate, false, true);
  const d = (await w.delegate()).json;
  const raised = (
    await w.register(d.id, {
      key: "effective:caller",
      amountMinor: 500,
      assertion: "human",
    })
  ).json;
  const floor = (
    await w.register(d.id, {
      key: "effective:operator",
      amountMinor: 15000,
      assertion: "none",
    })
  ).json;
  for (const op of [raised, floor]) {
    assert.equal(op.decision, "approval_required");
    const event = await w.store.pool.query(
      "select evaluation from authority.audit_events where operation_id=$1 and type='policy.shadow_evaluated'",
      [op.id],
    );
    assert.equal(event.rows[0].evaluation.decision, "approval_required");
  }
  const token = await w.idp.service(CLIENTS.api, ["policies:write"]);
  const simulation = await w.call(
    "POST",
    `/v1/policies/${encodeURIComponent(scope)}/simulate`,
    { token, body: { version: candidate.version, since: "30d" } },
  );
  assert.equal(simulation.status, 200);
  assert.ok(
    !simulation.json.changed.some((c: any) =>
      [raised.id, floor.id].includes(c.operationId),
    ),
  );
});

test("compiled CEL is cached per policy version and rule, and recompiles when the expression changes", () => {
  const p = document("cel-cache");
  const rules = p.actions["refund:create"]!.rules;
  rules.push({ id: "big", when: "args.amountMinor > 5", then: { allow: {} } });
  const inputs = { args: { amountMinor: 100 }, actor: { type: "agent" } };
  const before = conditionCacheStats();
  for (let n = 0; n < 5; n++) evaluatePolicy(p, "refund:create", inputs);
  const after = conditionCacheStats();
  assert.equal(after.misses - before.misses, 2, "each rule compiles once");
  assert.equal(after.hits - before.hits, 8);
  rules[1]!.when = "args.amountMinor > 1000";
  evaluatePolicy(p, "refund:create", inputs);
  assert.equal(conditionCacheStats().misses - after.misses, 1);
  assert.deepEqual(
    evaluatePolicy(p, "refund:create", inputs).ruleIds.includes("big"),
    false,
  );
});

test("the operator approver floor holds for omitted actions, unknown-action handling and stale versions", async () => {
  const weak = document("floor-weak");
  weak.unknown_action = "approve";
  weak.unknown_action_approvers = { relation: "member", on: "organization" };
  // deploy:production has an operator approver floor but is omitted from the document.
  const token = await w.idp.service(CLIENTS.api, ["policies:write"]);
  const put = (document: PolicyDocument) =>
    w.call("PUT", `/v1/policies/${encodeURIComponent(scope)}`, {
      token,
      body: { document, activate: false },
    });
  const rejected = await put(weak);
  assert.equal(rejected.status, 400, JSON.stringify(rejected.json));
  assert.match(JSON.stringify(rejected.json), /approver floor/);
  const matching = document("floor-ok");
  matching.unknown_action = "approve";
  matching.unknown_action_approvers = {
    relation: "deploy_approve",
    on: "organization",
  };
  assert.equal((await put(matching)).status, 201);

  // A version stored before the floor existed (or edited out of band) is still floored at evaluation.
  const ctx = { tenant: w.tenant } as any;
  const unknown = applyRequirementFloor(
    ctx,
    weak,
    "deploy:production",
    {},
    undefined,
    evaluatePolicy(weak, "deploy:production", { args: {} }),
  );
  assert.equal(unknown.decision, "approval_required");
  assert.equal(unknown.approverRelation, "deploy_approve");
  const listed = document("floor-listed");
  listed.actions["refund:create"]!.approvers.relation = "member";
  const flooredListed = applyRequirementFloor(
    ctx,
    listed,
    "refund:create",
    {},
    undefined,
    evaluatePolicy(listed, "refund:create", { args: { amountMinor: 20000 } }),
  );
  assert.equal(flooredListed.approverRelation, "refund_approve");

  // End to end: the approval is requested under the operator relation, not the stored one.
  const stored = document("floor-stored");
  stored.actions["refund:create"]!.approvers.relation = "member";
  stored.actions["refund:create"]!.rules = [];
  await w.store.pool.query(
    "insert into authority.policy_versions(tenant_id,resource_server,version,document,created_by,created_at) values($1,$2,$3,$4,'test',$5)",
    [w.tenant.tenantId, scope, stored.version, JSON.stringify(stored), w.iso()],
  );
  await w.store.pool.query(
    "update authority.policy_state set active_version=$3 where tenant_id=$1 and resource_server=$2",
    [w.tenant.tenantId, scope, stored.version],
  );
  const d = (await w.delegate()).json;
  const op = await w.register(d.id, { key: "floor:stored", amountMinor: 500 });
  assert.equal(op.json.decision, "approval_required");
  const ap = await w.requestApproval(op.json.id);
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  const row = await w.store.pool.query(
    "select permission from authority.approvals where id=$1",
    [ap.json.id],
  );
  assert.equal(row.rows[0].permission, "refund_approve");
});

test("budgets must declare their amount argument and an exhausted budget never falls through to a bare allow", async () => {
  const noArg = document("budget-no-arg");
  noArg.actions["refund:create"]!.arguments = { cents: "int" };
  noArg.actions["refund:create"]!.rules[0]!.when = 'actor.type == "agent"';
  assert.throws(() => validatePolicy(noArg), /amount_arg/);
  const wrongType = structuredClone(noArg);
  const budget = (p: PolicyDocument) =>
    (p.actions["refund:create"]!.rules[0]!.then as any).allow.budget;
  budget(wrongType).amount_arg = "missing";
  assert.throws(() => validatePolicy(wrongType), /amount_arg/);
  budget(noArg).amount_arg = "cents";
  assert.doesNotThrow(() => validatePolicy(noArg));
  const countOnly = structuredClone(noArg);
  delete budget(countOnly).max_amount_minor;
  delete budget(countOnly).amount_arg;
  assert.doesNotThrow(() => validatePolicy(countOnly));

  const bare = document("budget-bare-default");
  bare.actions["refund:create"]!.default = { allow: {} };
  assert.throws(() => validatePolicy(bare), /unbudgeted allow/);
  // A version stored before that check still denies an over-budget request.
  const inputs = { args: { amountMinor: 100 }, actor: { type: "agent" } };
  assert.equal(evaluatePolicy(bare, "refund:create", inputs).decision, "allow");
  const over = evaluatePolicy(
    bare,
    "refund:create",
    inputs,
    new Set(["small"]),
  );
  assert.equal(over.decision, "deny");
  assert.equal(over.reasonCode, "budget_exhausted");

  // The declared argument, not a hard-coded name, is what the cap counts.
  const custom = structuredClone(noArg);
  custom.version = "budget-cents";
  custom.actions["refund:create"]!.rules[0]!.id = "cents-small";
  await apply(custom);
  const d = (await w.delegate()).json;
  const first = await w.register(d.id, {
    key: "cents:a",
    assertion: "none",
    args: { cents: 10000 },
  });
  assert.equal(first.json.decision, "allow", JSON.stringify(first.json));
  const second = await w.register(d.id, {
    key: "cents:b",
    assertion: "none",
    args: { cents: 10000 },
  });
  assert.equal(second.json.decision, "approval_required");
});

test("tier idle_timeout is a validated duration and merges to the strictest", () => {
  const p = document("idle");
  p.tiers.routine = { ...p.tiers.routine!, idle_timeout: "10m" };
  assert.doesNotThrow(() => validatePolicy(p));
  p.tiers.routine!.idle_timeout = "soon";
  assert.throws(() => validatePolicy(p));
  const q = document("idle-merge");
  q.tiers.a = {
    assurance: "session_mfa",
    idle_timeout: "10m",
    dpop: "optional",
  };
  q.tiers.b = {
    assurance: "session_mfa",
    idle_timeout: "2m",
    factors: ["otp"],
  };
  q.actions["refund:create"]!.rules = [
    { id: "a", when: "true", then: { approve: { tier: "a" } } },
    { id: "b", when: "true", then: { approve: { tier: "b" } } },
  ];
  const r = evaluatePolicy(q, "refund:create", { args: { amountMinor: 1 } });
  assert.equal(r.assurance?.idle_timeout, "2m");
  assert.deepEqual(r.assurance?.factors, ["otp"]);
});

test("the operator's auto-approve ceiling fails closed on values it cannot compare", () => {
  const ctx = {
    tenant: {
      ...w.tenant,
      actions: {
        ...w.tenant.actions,
        "refund:create": {
          ...w.tenant.actions["refund:create"]!,
          autoApproveCeilings: { amountMinor: 10000 },
        },
      },
    },
  } as any;
  const allow = evaluatePolicy(null, "refund:create", { args: {} });
  const allowed = { ...allow, decision: "allow" as const };
  const floor = (args: Record<string, unknown>) =>
    applyRequirementFloor(ctx, null, "refund:create", args, "none", allowed)
      .decision;
  assert.equal(floor({ amountMinor: 5000 }), "allow");
  assert.equal(floor({}), "allow");
  assert.equal(floor({ amountMinor: 20000 }), "approval_required");
  // A string or fraction cannot be shown to be under the ceiling.
  assert.equal(floor({ amountMinor: "20000" }), "approval_required");
  assert.equal(floor({ amountMinor: 1.5 }), "approval_required");
});
