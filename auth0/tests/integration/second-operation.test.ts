import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  requestDeploy,
  runDeploy,
} from "../../../demo/deploy-gate/src/deploy.js";
import { createDesk, type Desk } from "../helpers/desk.js";
import { AGENTS, ORG, PEOPLE } from "../helpers/world.js";

let d: Desk;
before(async () => {
  d = await createDesk();
  const resourceServer = `org:${ORG.northstar}/deploys`;
  const document = {
    resource_server: resourceServer,
    version: "deploy-test-v1",
    unknown_action: "deny",
    actions: {
      "deploy:production": {
        arguments: { environment: "string" },
        approvers: { relation: "deploy_approve", on: "organization" },
        rules: [],
        default: { approve: { tier: "high_value" } },
      },
    },
    tiers: { high_value: { assurance: "per_operation", max_age: 300 } },
  };
  const applied = await d.w.call(
    "PUT",
    `/v1/policies/${encodeURIComponent(resourceServer)}`,
    {
      token: await d.w.idp.service("policy_admin", ["policies:write"]),
      body: { document, activate: true },
    },
  );
  assert.equal(applied.status, 201, JSON.stringify(applied.json));
});
after(async () => d.close());

test("production deploy approval reuses the same SDK/service contract with different business semantics (FR-042)", async () => {
  const who = {
    subjectToken: await d.w.tok.user(PEOPLE.dana, ORG.northstar),
    orgId: ORG.northstar,
    agentId: AGENTS.deployBot,
  };
  const { op, approval } = await requestDeploy(d.authority, who, {
    service: "checkout",
    version: "v2026.10.13",
    changeId: "CHG-1042",
  });
  assert.equal(op.approvalRequirement, "human");
  let deploys = 0;
  const deployer = async () => ({ id: `run_${++deploys}` });

  const early = await runDeploy(d.executor, op, deployer);
  assert.ok(early.decision === "denied" && early.code === "approval_pending");
  assert.equal(deploys, 0);

  // The refund approver (Morgan) holds refund_approve, not deploy_approve: per-action eligibility from FGA.
  const wrong = await d.w.approve(approval.id, op.digest, {
    person: PEOPLE.morgan,
  });
  assert.equal(wrong.json.code, "approver_ineligible");
  // The requester cannot approve their own deploy.
  assert.equal(
    (await d.w.approve(approval.id, op.digest, { person: PEOPLE.dana })).json
      .code,
    "approver_ineligible",
  );
  // The Southridge manager cannot, either.
  assert.equal(
    (
      await d.w.approve(approval.id, op.digest, {
        person: PEOPLE.mallory,
        org: ORG.southridge,
      })
    ).json.code,
    "not_authorized",
  );

  assert.equal(
    (await d.w.approve(approval.id, op.digest, { person: PEOPLE.lee })).status,
    200,
  );
  const ok = await runDeploy(d.executor, op, deployer);
  assert.equal(ok.decision, "authorized");
  assert.equal(deploys, 1);
  const again = await runDeploy(d.executor, op, deployer);
  assert.equal(again.decision, "reconcile_required");
  assert.equal(
    deploys,
    1,
    "a second run needs reconciliation, not a second deploy",
  );
});

test("refund permissions do not leak into deploys and the reverse (no refund-specific authz in the service)", async () => {
  const who = {
    subjectToken: await d.w.tok.user(PEOPLE.alice, ORG.northstar),
    orgId: ORG.northstar,
    agentId: AGENTS.deployBot,
  };
  // Alice is a refund requester, not a deploy requester.
  await assert.rejects(
    requestDeploy(d.authority, who, {
      service: "checkout",
      version: "v-alice",
      changeId: "CHG-1",
    }),
    (e: { code?: string; details?: { reason?: string } }) =>
      e.code === "not_authorized" &&
      e.details?.reason === "grantor_lacks_permission",
  );
});
