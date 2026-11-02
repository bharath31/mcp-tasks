import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TaskAuthority,
  outcomeExitCode,
  renderCli,
  renderMcp,
  renderRest,
  type OperationView,
} from "@task-authority/sdk";

const operation = (extra: Partial<OperationView> = {}): OperationView => ({
  id: "op_guard",
  tenantId: "t",
  organizationId: "org",
  delegationId: "d",
  operationKey: "refund:1",
  taskId: null,
  action: "refund:create",
  resource: "payment:1",
  canonicalVersion: 1,
  digest: "sha256:exact",
  approvalRequirement: "none",
  status: "registered",
  businessStateVersion: "100:0:USD",
  expiresAt: "2030-01-01T00:00:00Z",
  correlationId: "cor",
  approvalId: null,
  approvalStatus: null,
  claim: null,
  decision: "allow",
  reasonCode: "policy_allowed",
  ruleIds: ["small"],
  policyVersion: "v7",
  ...extra,
});
function guard(
  op: OperationView,
  claim: unknown = { decision: "authorized", claimId: "cl_1" },
) {
  const requests: Array<{ path: string; body: any }> = [];
  const client = new TaskAuthority({
    baseUrl: "https://authority.test",
    getAccessToken: async () => "backend",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const result = path.endsWith("/claims")
        ? claim
        : path.endsWith("/approval-requests")
          ? { id: "ap_1", status: "pending" }
          : op;
      return Response.json(result);
    },
  });
  return { client, requests };
}
const facts = () => ({
  operationKey: "refund:1",
  resource: "payment:1",
  arguments: { amountMinor: 500 },
  facts: { refundableMinor: 1000 },
});

test("protect executes only after claiming and forwards business facts with no default caller assertion", async () => {
  const { client, requests } = guard(operation());
  let effects = 0;
  const result = await client.protect("refund:create", facts, async (claim) => {
    assert.equal(requests.at(-1)!.path, "/v1/operations/op_guard/claims");
    assert.equal(claim.decision, "authorized");
    effects++;
    return { refundId: "refund_1" };
  });
  assert.equal(effects, 1);
  assert.equal(requests[0]!.body.approvalAssertion, undefined);
  assert.deepEqual(requests[0]!.body.facts, { refundableMinor: 1000 });
  assert.equal(requests[1]!.body.operationDigest, "sha256:exact");
  assert.equal((await renderRest(result)).status, 201);
  assert.equal(renderMcp(result).status, "completed");
  assert.equal(renderCli(result).exitCode, 0);
});

test("approval renders REST 202 plus operation and review URLs with no claim or side effect", async () => {
  const { client, requests } = guard(
    operation({
      decision: "approval_required",
      approvalRequirement: "human",
      reasonCode: "over_limit",
      ruleIds: ["over-100"],
    }),
  );
  const result = await client.protect("refund:create", facts, async () => {
    assert.fail("must never execute");
  });
  assert.equal(result.decision, "approval_required");
  const response = renderRest(result);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("location"), "/v1/operations/op_guard");
  assert.match(result.reviewUrl!, /ap_1/);
  assert.equal(requests.length, 2);
  assert.deepEqual(renderMcp(result).authority, {
    decision: "approval_required",
    reasonCode: "over_limit",
    policyVersion: "v7",
    ruleIds: ["over-100"],
  });
});

test("owner approval: every transport points at the same approval; MCP asks the owner with a URL elicitation", async () => {
  const { client } = guard(
    operation({
      decision: "approval_required",
      approvalRequirement: "human",
      reasonCode: "over_limit",
      ownerApproval: true,
    }),
  );
  const result = await client.protect("refund:create", facts, async () => {
    assert.fail("must never execute");
  });
  const rest = renderRest(result);
  assert.equal(rest.status, 202);
  assert.equal((await rest.json()).reviewUrl, result.reviewUrl);
  const cli = renderCli(result);
  assert.equal(cli.waitUrl, "/v1/operations/op_guard");
  assert.equal(JSON.parse(cli.output).reviewUrl, result.reviewUrl);
  const mcp = renderMcp(result);
  assert.equal(mcp.status, "input_required");
  assert.deepEqual(Object.keys(mcp.inputRequests ?? {}), [
    "owner_approval:ap_1",
  ]);
  assert.deepEqual(mcp.inputRequests?.["owner_approval:ap_1"], {
    method: "elicitation/create",
    params: {
      mode: "url",
      elicitationId: "ap_1",
      url: result.reviewUrl,
      message:
        "Approve this operation with your passkey. Your agent continues only after you approve.",
    },
  });
  // Headless hosts cancel tasks that ask for input, so the owner can be pointed at the page instead.
  const quiet = renderMcp(result, { ownerPrompt: "status" });
  assert.equal(quiet.status, "working");
  assert.equal(quiet.inputRequests, undefined);
  assert.equal(
    quiet.statusMessage,
    `Waiting for you to approve: ${result.reviewUrl}`,
  );
  // Without owner approval the agent just waits for a reviewer; nothing is asked of the user.
  const { client: reviewed } = guard(
    operation({ decision: "approval_required", approvalRequirement: "human" }),
  );
  const waiting = renderMcp(
    await reviewed.protect("refund:create", facts, async () => {
      assert.fail("must never execute");
    }),
  );
  assert.equal(waiting.status, "working");
  assert.equal(waiting.inputRequests, undefined);
});

test("denials and caller step-up never claim; HTTP challenges are RFC 9470 and escape policy data", async () => {
  for (const decision of ["deny", "step_up_required"] as const) {
    const { client, requests } = guard(operation({ decision }));
    const result = await client.protect("refund:create", facts, async () => {
      assert.fail("must never execute");
    });
    assert.equal(requests.length, 1);
    const response = renderRest(result);
    assert.equal(response.status, decision === "deny" ? 403 : 401);
    if (decision === "step_up_required")
      assert.match(
        response.headers.get("www-authenticate")!,
        /insufficient_user_authentication/,
      );
  }
});

test("prepare and resume preserve the exact operation and reconciliation never invents a fresh claim", async () => {
  const { client, requests } = guard(operation(), {
    decision: "reconcile_required",
    claimId: "old_claim",
  });
  const prepared = await client.protect(
    "refund:create",
    facts,
    async () => assert.fail(),
    { prepareOnly: true },
  );
  assert.equal(prepared.executed, false);
  assert.equal(requests.length, 1);
  const resumed = await client.protect(
    "refund:create",
    () => assert.fail("must not register twice"),
    async () => assert.fail("must not mutate during reconciliation"),
    {
      operation: prepared.operation,
      reconcile: async (claim) => {
        assert.equal(claim.decision, "reconcile_required");
        return "read-only provider reconciliation";
      },
    },
  );
  assert.equal(resumed.result, "read-only provider reconciliation");
  assert.equal(requests.length, 2);
  await assert.rejects(
    client.protect("other:action", facts, async () => assert.fail(), {
      operation: prepared.operation,
    }),
    /protected_action_mismatch/,
  );
});

test("a final claim refusal prevents execution even after registration allowed it", async () => {
  const { client } = guard(operation(), {
    decision: "denied",
    code: "approver_ineligible",
    reason: "approver_ineligible",
    operationId: "op_guard",
  });
  const result = await client.protect("refund:create", facts, async () =>
    assert.fail("must not execute"),
  );
  assert.equal(result.decision, "approval_required");
  assert.equal(result.reasonCode, "approver_ineligible");
  assert.equal(result.executed, false);
});

test("an uncertain previous claim never invokes a mutation without an explicit reconciliation handler", async () => {
  const { client } = guard(operation(), {
    decision: "reconcile_required",
    claimId: "old_claim",
  });
  const result = await client.protect("refund:create", facts, async () =>
    assert.fail("must never replay an uncertain mutation"),
  );
  assert.equal(result.executed, false);
  assert.equal(result.reasonCode, "reconcile_required");
  assert.equal(renderRest(result).status, 202);
});

test("policy caller step-up requirements are identical in HTTP and MCP challenge renderers", async () => {
  const { client } = guard(
    operation({
      decision: "step_up_required",
      stepUp: { acr: "urn:custom:strong", max_age: 45 },
    }),
  );
  const result = await client.protect("refund:create", facts, async () =>
    assert.fail(),
  );
  assert.equal(
    renderRest(result).headers.get("www-authenticate"),
    'Bearer error="insufficient_user_authentication", acr_values="urn:custom:strong", max_age="45"',
  );
  assert.equal(
    renderMcp(result).authorizationChallenge?.acr_values,
    "urn:custom:strong",
  );
  assert.equal(renderMcp(result).authorizationChallenge?.max_age, 45);
});

test("prepareOnly never requests human approval or claims; the review opens when protect resumes", async () => {
  const pending = operation({
    decision: "approval_required",
    approvalRequirement: "human",
  });
  const { client, requests } = guard(pending);
  const prepared = await client.protect(
    "refund:create",
    facts,
    async () => assert.fail("must never execute"),
    { prepareOnly: true },
  );
  assert.equal(prepared.decision, "approval_required");
  assert.equal(prepared.executed, false);
  assert.equal(prepared.reviewUrl, undefined);
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/v1/operations"],
  );
  const resumed = await client.protect(
    "refund:create",
    () => assert.fail("must not register twice"),
    async () => assert.fail("must never execute"),
    { operation: prepared.operation },
  );
  assert.equal(resumed.decision, "approval_required");
  assert.ok(resumed.reviewUrl);
  assert.ok(requests.some((r) => r.path.endsWith("/approval-requests")));
});

test("an operation awaiting caller step-up has its own outcome status and exit code", () => {
  assert.equal(outcomeExitCode("step_up_required"), 2);
  assert.equal(outcomeExitCode("approved"), 0);
  assert.equal(outcomeExitCode("denied"), 1);
});
