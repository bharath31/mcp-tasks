import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { refundCli } from "../../../demo/refund-desk/src/cli.js";
import { createDesk, type Desk } from "../helpers/desk.js";
import { ORG, PEOPLE } from "../helpers/world.js";

let desk: Desk;
before(async () => {
  desk = await createDesk();
});
after(async () => {
  await desk?.close();
});
const metadata = (outcome: any) => ({
  decision: outcome.decision,
  reasonCode: outcome.reasonCode,
  policyVersion: outcome.policyVersion,
  ruleIds: outcome.ruleIds,
});
const transportFetch: typeof fetch = async (input, init) =>
  desk.app(new Request(String(input), init));
const post = (token: string, refund: unknown) =>
  desk.app(
    new Request("https://refund-desk.test/v1/refunds", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(refund),
    }),
  );

test("same operation and principal produce identical MCP, REST and CLI decision metadata and audit records", async () => {
  for (const amountMinor of [5000, 15000]) {
    const paymentId = await desk.payment();
    const token = await desk.alice();
    const request = {
      orderId: `parity-${amountMinor}`,
      paymentId,
      amountMinor,
      currency: "USD",
      reason: "Returned item verified by support",
      exceptionNote: "Warehouse return will be verified before dispatch",
    };
    const mcp = await desk.rpc(
      "tools/call",
      { name: "request_refund", arguments: request },
      { token },
    );
    assert.equal(mcp.body.result.resultType, "task");
    const mcpDecision = mcp.body.result._meta["task-authority/decision"];
    const operationId = mcpDecision.operationId;
    const auditBefore = await desk.service.o.auditor!.audit.list(operationId);
    const rest = await post(token, request);
    assert.equal(rest.status, 202);
    assert.equal(rest.headers.get("location"), `/v1/operations/${operationId}`);
    const restBody = await rest.json();
    assert.deepEqual(metadata(restBody), metadata(mcpDecision));
    assert.equal(
      restBody.decision,
      amountMinor > 10000 ? "approval_required" : "allow",
    );
    // Preparing the operation does not wake a reviewer before the warehouse return is verified.
    if (amountMinor > 10000) assert.equal(restBody.reviewUrl, undefined);
    const printed: string[] = [];
    assert.equal(
      await refundCli({
        baseUrl: "https://refund-desk.test",
        accessToken: token,
        refund: request,
        fetch: transportFetch,
        print: (line) => printed.push(line),
      }),
      0,
    );
    assert.deepEqual(metadata(JSON.parse(printed[0]!)), metadata(mcpDecision));
    assert.equal(JSON.parse(printed[0]!).operation.id, operationId);
    const auditAfter = await desk.service.o.auditor!.audit.list(operationId);
    assert.deepEqual(
      auditAfter,
      auditBefore,
      "transport retries must not mint another policy decision, approval or claim",
    );
    assert.equal(
      desk.payments.calls.length,
      0,
      "warehouse prerequisite and approval are enforced on all transports",
    );
    const status = await desk.app(
      new Request(`https://refund-desk.test/v1/operations/${operationId}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    assert.equal(status.status, 200);
    assert.equal((await status.json()).policyVersion, "desk-policy-v1");
  }
});

test("human-direct native client needs no agent delegation and status is private to initiator and eligible reviewers", async () => {
  const token = await desk.mcpToken(PEOPLE.alice, ORG.northstar, {
    client: "refund_cli_human",
  });
  const paymentId = await desk.payment();
  const response = await post(token, {
    orderId: "human-direct",
    paymentId,
    amountMinor: 15000,
    currency: "USD",
    reason: "Human support request",
    exceptionNote: "Exception details reviewed by support",
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.operation.delegationId, null);
  assert.equal(body.operation.actor.type, "human");
  const path = `https://refund-desk.test/v1/operations/${body.operation.id}`;
  const outsider = await desk.mcpToken(PEOPLE.eve, ORG.northstar);
  const outsiderResponse = await desk.app(
    new Request(path, { headers: { authorization: `Bearer ${outsider}` } }),
  );
  assert.ok([403, 404].includes(outsiderResponse.status));
  const reviewer = await desk.mcpToken(PEOPLE.morgan, ORG.northstar, {
    client: "refund_cli_human",
  });
  assert.equal(
    (
      await desk.app(
        new Request(path, { headers: { authorization: `Bearer ${reviewer}` } }),
      )
    ).status,
    200,
  );
  const self = await desk.w.call(
    "POST",
    `/v1/approval-requests/${body.operation.approvalId}/decisions`,
    {
      token: await desk.w.tok.user(PEOPLE.alice, ORG.northstar),
      body: { decision: "approve", operationDigest: body.operation.digest },
    },
  );
  assert.ok([401, 403].includes(self.status));
});

test("CLI --wait polls the operation and returns its terminal result without dispatching a second refund", async () => {
  const paymentId = await desk.payment();
  const token = await desk.alice();
  const request = {
    orderId: "cli-wait",
    paymentId,
    amountMinor: 5000,
    currency: "USD",
    reason: "Returned item qualifies",
  };
  let polls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if ((init?.method ?? "GET") === "GET") {
      polls++;
      await desk.warehouse(request.orderId, paymentId);
      await desk.tick(2);
    }
    return transportFetch(input, init);
  };
  const printed: string[] = [];
  const code = await refundCli({
    baseUrl: "https://refund-desk.test",
    accessToken: token,
    refund: request,
    wait: true,
    timeoutMs: 10000,
    fetch: fetcher,
    print: (line) => printed.push(line),
    sleep: async () => {
      await desk.tick(2);
    },
  });
  assert.equal(code, 0);
  assert.ok(polls >= 1);
  assert.equal(JSON.parse(printed.at(-1)!).status, "completed");
  assert.equal(
    desk.payments.calls.filter((call) => call.paymentId === paymentId).length,
    1,
  );
});

test("each transport's first request reaches the same policy and audit trail before any side effect", async () => {
  const token = await desk.alice();
  const paymentId = await desk.payment();
  const decisions: unknown[] = [];
  const audits: unknown[] = [];
  for (const transport of ["mcp", "rest", "cli"] as const) {
    const request = {
      orderId: `first-${transport}`,
      paymentId,
      amountMinor: 15000,
      currency: "USD",
      reason: "Equivalent business facts",
      exceptionNote: "Identical reviewer context for parity",
    };
    let decision: any;
    if (transport === "mcp") {
      const result = await desk.rpc(
        "tools/call",
        { name: "request_refund", arguments: request },
        { token },
      );
      decision = result.body.result._meta["task-authority/decision"];
    } else if (transport === "rest") {
      decision = await (await post(token, request)).json();
    } else {
      const printed: string[] = [];
      assert.equal(
        await refundCli({
          baseUrl: "https://refund-desk.test",
          accessToken: token,
          refund: request,
          fetch: transportFetch,
          print: (line) => printed.push(line),
        }),
        0,
      );
      decision = JSON.parse(printed[0]!);
    }
    decisions.push(metadata(decision));
    const operationId = decision.operationId ?? decision.operation.id;
    const events = await desk.service.o.auditor!.audit.list(operationId);
    audits.push(
      events.map((event) => ({
        type: event.type,
        decision: event.decision,
        reasonCode: event.reasonCode,
        actor: event.actor,
      })),
    );
  }
  assert.deepEqual(decisions[0], decisions[1]);
  assert.deepEqual(decisions[1], decisions[2]);
  assert.deepEqual(audits[0], audits[1]);
  assert.deepEqual(audits[1], audits[2]);
  assert.equal(
    desk.payments.calls.filter((call) => call.paymentId === paymentId).length,
    0,
  );
});

test("policy denial and human caller step-up have the same refusal on all three transports", async () => {
  const resourceServer = "https://refund-desk.test/mcp";
  const stored = await desk.w.store.pool.query(
    "select document from authority.policy_versions where tenant_id=$1 and resource_server=$2 and version='desk-policy-v1'",
    [desk.w.tenant.tenantId, resourceServer],
  );
  const document = structuredClone(stored.rows[0].document);
  document.version = "parity-refusals-v1";
  document.actions["refund:create"].rules.unshift(
    {
      id: "blocked-amount",
      when: "args.amountMinor == 7777",
      then: { deny: { reason: "refund_blocked" } },
    },
    {
      id: "human-strong-assurance",
      when: 'actor.type == "human" && args.amountMinor == 8888',
      then: { step_up: { acr: "mfa", max_age: 45 } },
    },
  );
  await desk.w.store.pool.query(
    "insert into authority.policy_versions(tenant_id,resource_server,version,document,created_by,created_at) values($1,$2,$3,$4,'fixture',now())",
    [
      desk.w.tenant.tenantId,
      resourceServer,
      document.version,
      JSON.stringify(document),
    ],
  );
  await desk.w.store.pool.query(
    "update authority.policy_state set active_version=$3 where tenant_id=$1 and resource_server=$2",
    [desk.w.tenant.tenantId, resourceServer, document.version],
  );
  const token = await desk.mcpToken(PEOPLE.alice, ORG.northstar, {
    client: "refund_cli_human",
  });
  for (const amountMinor of [7777, 8888]) {
    const paymentId = await desk.payment();
    const decision = amountMinor === 7777 ? "deny" : "step_up_required";
    const expectedStatus = amountMinor === 7777 ? 403 : 401;
    const snapshots: unknown[] = [];
    for (const channel of ["mcp", "rest", "cli"] as const) {
      const request = {
        orderId: `refusal-${amountMinor}-${channel}`,
        paymentId,
        amountMinor,
        currency: "USD",
        reason: "Policy parity refusal scenario",
      };
      if (channel === "mcp") {
        const response = await desk.rpc(
          "tools/call",
          { name: "request_refund", arguments: request },
          { token },
        );
        if (decision === "deny") {
          assert.equal(response.body.result.status, "failed");
          snapshots.push(
            metadata(response.body.result._meta["task-authority/decision"]),
          );
        } else {
          assert.equal(response.status, expectedStatus);
          assert.match(
            response.headers.get("www-authenticate")!,
            /max_age="45"/,
          );
          snapshots.push(metadata(response.body.error.data.operation));
        }
      } else if (channel === "rest") {
        const response = await post(token, request);
        assert.equal(response.status, expectedStatus);
        const body = await response.json();
        snapshots.push(metadata(body.operation));
      } else {
        const printed: string[] = [];
        const code = await refundCli({
          baseUrl: "https://refund-desk.test",
          accessToken: token,
          refund: request,
          fetch: transportFetch,
          print: (line) => printed.push(line),
        });
        assert.equal(code, decision === "deny" ? 1 : 2);
        snapshots.push(metadata(JSON.parse(printed[0]!).operation));
      }
    }
    assert.deepEqual(snapshots[0], snapshots[1]);
    assert.deepEqual(snapshots[1], snapshots[2]);
    assert.equal((snapshots[0] as any).decision, decision);
    assert.equal(
      desk.payments.calls.filter((call) => call.paymentId === paymentId).length,
      0,
    );
  }
});

test("owner approval lives at the resource server: MCP asks the owner, REST sees the same approval, one passkey approval releases one refund", async () => {
  const resourceServer = "https://refund-desk.test/mcp";
  const stored = await desk.w.store.pool.query(
    "select document from authority.policy_versions where tenant_id=$1 and resource_server=$2 and version='desk-policy-v1'",
    [desk.w.tenant.tenantId, resourceServer],
  );
  const document = structuredClone(stored.rows[0].document);
  document.version = "owner-approval-v1";
  document.actions["refund:create"].self_approval = "owner";
  await desk.w.store.pool.query(
    "insert into authority.policy_versions(tenant_id,resource_server,version,document,created_by,created_at) values($1,$2,$3,$4,'fixture',now())",
    [
      desk.w.tenant.tenantId,
      resourceServer,
      document.version,
      JSON.stringify(document),
    ],
  );
  await desk.w.store.pool.query(
    "update authority.policy_state set active_version=$3 where tenant_id=$1 and resource_server=$2",
    [desk.w.tenant.tenantId, resourceServer, document.version],
  );
  const token = await desk.alice();
  const paymentId = await desk.payment();
  const request = {
    orderId: "owner-approval",
    paymentId,
    amountMinor: 15000,
    currency: "USD",
    reason: "Returned item verified by support",
    exceptionNote: "Owner approves their own agent's exception",
  };
  const mcp = await desk.rpc(
    "tools/call",
    { name: "request_refund", arguments: request },
    { token },
  );
  const taskId = mcp.body.result.taskId;
  await desk.warehouse(request.orderId, paymentId);
  await desk.step(0);

  // MCP: the agent's user is asked in their client to approve on the hosted page.
  const asked = await desk.get(taskId);
  assert.equal(asked.status, "input_required", JSON.stringify(asked));
  const [firstKey] = Object.keys(asked.inputRequests);
  const elicitation = asked.inputRequests[firstKey!];
  assert.equal(elicitation.params.mode, "url");
  let approvalId = elicitation.params.elicitationId;
  // One key per request (MCP Tasks): the key names this approval.
  assert.equal(firstKey, `owner_approval:${approvalId}`);
  assert.match(elicitation.params.url, new RegExp(approvalId));

  // REST: the same request from another client lands on the same operation and approval.
  const rest = await post(token, request);
  assert.equal(rest.status, 202);
  const restBody = await rest.json();
  assert.equal(restBody.operation.approvalId, approvalId);
  assert.equal(restBody.operation.ownerApproval, true);
  assert.equal(restBody.reviewUrl, elicitation.params.url);
  assert.equal(
    desk.payments.calls.filter((c) => c.paymentId === paymentId).length,
    0,
  );

  // "accept" only means the user went to the page; nothing is released yet.
  await desk.rpc(
    "tasks/update",
    { taskId, inputResponses: { [firstKey!]: { action: "accept" } } },
    { token },
  );
  await desk.step(16_000);
  const waiting = await desk.get(taskId);
  assert.equal(waiting.status, "working");
  assert.equal(
    desk.payments.calls.filter((c) => c.paymentId === paymentId).length,
    0,
  );

  // The owner never finished; the approval expires and a fresh one is requested. The new
  // request must carry a new key, or a spec-following client (which never answers a key
  // twice and deduplicates by key) would never show it and the task would stall.
  await desk.step(31 * 60_000);
  let again = await desk.get(taskId);
  for (let i = 0; i < 5 && again.status !== "input_required"; i++) {
    await desk.step(16_000);
    again = await desk.get(taskId);
  }
  assert.equal(again.status, "input_required", JSON.stringify(again));
  const [secondKey] = Object.keys(again.inputRequests);
  assert.notEqual(secondKey, firstKey);
  approvalId = again.inputRequests[secondKey!].params.elicitationId;
  assert.equal(secondKey, `owner_approval:${approvalId}`);
  // A late answer to the superseded key is ignored.
  await desk.rpc(
    "tasks/update",
    { taskId, inputResponses: { [firstKey!]: { action: "decline" } } },
    { token },
  );
  assert.equal((await desk.get(taskId)).status, "input_required");
  await desk.rpc(
    "tasks/update",
    { taskId, inputResponses: { [secondKey!]: { action: "accept" } } },
    { token },
  );

  // The owner approves once, with a passkey bound to this operation.
  const op = await desk.authority.operations.get(restBody.operation.id);
  const decided = await desk.w.call(
    "POST",
    `/v1/approval-requests/${approvalId}/decisions`,
    {
      token: await desk.w.idp.mint({
        sub: PEOPLE.alice,
        orgId: ORG.northstar,
        mfa: true,
        claims: { amr: ["pwd", "mfa", "webauthn-platform"] },
        details: [
          {
            type: "task_authority_approval",
            approval_id: approvalId,
            operation_digest: op.digest,
          },
        ],
      }),
      body: { decision: "approve", operationDigest: op.digest },
    },
  );
  assert.equal(decided.status, 200, JSON.stringify(decided.json));
  let done = await desk.get(taskId);
  for (let i = 0; i < 10 && done.status === "working"; i++) {
    await desk.step(16_000);
    done = await desk.get(taskId);
  }
  assert.equal(done.status, "completed", JSON.stringify(done));
  // A retry over REST after completion does not refund again.
  await post(token, request);
  assert.equal(
    desk.payments.calls.filter((c) => c.paymentId === paymentId).length,
    1,
  );
});

test("headless hosts: with ownerPrompt status the owner gets the link, is never asked for input, and one passkey approval releases one refund", async () => {
  const resourceServer = "https://refund-desk.test/mcp";
  const stored = await desk.w.store.pool.query(
    "select document from authority.policy_versions where tenant_id=$1 and resource_server=$2 and version='desk-policy-v1'",
    [desk.w.tenant.tenantId, resourceServer],
  );
  const document = structuredClone(stored.rows[0].document);
  document.version = "owner-approval-status-v1";
  document.actions["refund:create"].self_approval = "owner";
  await desk.w.store.pool.query(
    "insert into authority.policy_versions(tenant_id,resource_server,version,document,created_by,created_at) values($1,$2,$3,$4,'fixture',now())",
    [
      desk.w.tenant.tenantId,
      resourceServer,
      document.version,
      JSON.stringify(document),
    ],
  );
  await desk.w.store.pool.query(
    "update authority.policy_state set active_version=$3 where tenant_id=$1 and resource_server=$2",
    [desk.w.tenant.tenantId, resourceServer, document.version],
  );
  desk.service.o.ownerPrompt = "status";
  try {
    const token = await desk.alice();
    const paymentId = await desk.payment();
    const request = {
      orderId: "owner-headless",
      paymentId,
      amountMinor: 15000,
      currency: "USD",
      reason: "Returned item verified by support",
      exceptionNote: "Owner approves out of band",
    };
    const mcp = await desk.rpc(
      "tools/call",
      { name: "request_refund", arguments: request },
      { token },
    );
    const taskId = mcp.body.result.taskId;
    await desk.warehouse(request.orderId, paymentId);
    await desk.step(0);
    const rest = await (await post(token, request)).json();
    const approvalId = rest.operation.approvalId;
    assert.equal(rest.operation.ownerApproval, true);

    // Claude Code cancels any task that asks for input in a headless run, so none is asked.
    const waiting = await desk.get(taskId);
    assert.equal(waiting.status, "working", JSON.stringify(waiting));
    assert.equal(waiting.inputRequests, undefined);
    assert.equal(
      waiting.statusMessage,
      `Waiting for you to approve this refund: ${rest.reviewUrl}`,
    );

    const op = await desk.authority.operations.get(rest.operation.id);
    const decided = await desk.w.call(
      "POST",
      `/v1/approval-requests/${approvalId}/decisions`,
      {
        token: await desk.w.idp.mint({
          sub: PEOPLE.alice,
          orgId: ORG.northstar,
          mfa: true,
          claims: { amr: ["pwd", "mfa", "webauthn-platform"] },
          details: [
            {
              type: "task_authority_approval",
              approval_id: approvalId,
              operation_digest: op.digest,
            },
          ],
        }),
        body: { decision: "approve", operationDigest: op.digest },
      },
    );
    assert.equal(decided.status, 200, JSON.stringify(decided.json));
    let done = await desk.get(taskId);
    for (let i = 0; i < 10 && done.status === "working"; i++) {
      await desk.step(16_000);
      done = await desk.get(taskId);
    }
    assert.equal(done.status, "completed", JSON.stringify(done));
    // The result says how it was authorized, so the host's model cannot report "no approval".
    assert.deepEqual(done.result.structuredContent.authority.approval, {
      required: true,
      approvalId,
      status: "approved",
      ownerMayApprove: true,
    });
    assert.equal(
      done.result.structuredContent.exceptionNote,
      request.exceptionNote,
    );
    assert.equal(
      desk.payments.calls.filter((c) => c.paymentId === paymentId).length,
      1,
    );
  } finally {
    desk.service.o.ownerPrompt = undefined;
  }
});
