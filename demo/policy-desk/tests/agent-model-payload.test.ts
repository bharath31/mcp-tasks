import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFacingHistory, modelFacingToolResult } from "../src/agent.js";

const reviewUrl =
  "https://policy-desk.test/approve?r=eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImFwcl8xMjMifQ.signature";
const token = new URL(reviewUrl).searchParams.get("r")!;

test("model-facing Auth0 approval results hide signed links but preserve UI trace metadata", () => {
  const raw = {
    taskId: "apr_123",
    status: "working",
    statusMessage: `Waiting for a finance reviewer to approve: ${reviewUrl}`,
    _meta: {
      "task-authority/decision": {
        decision: "approval_required",
        reasonCode: "auth0_passkey_approval",
        approvalId: "apr_123",
        reviewUrl,
      },
    },
  };
  // runAgent builds the trace from this untouched MCP result before making a model copy.
  const traceTask = {
    taskId: raw.taskId,
    status: raw.status,
    statusMessage: raw.statusMessage,
    decision: raw._meta["task-authority/decision"],
  };
  const modelCopy = modelFacingToolResult(raw) as Record<string, any>;

  assert.equal(JSON.stringify(modelCopy).includes(token), false);
  assert.equal(JSON.stringify(modelCopy).includes("/approve?r="), false);
  assert.match(modelCopy.statusMessage, /Review this refund button above/);
  assert.equal(traceTask.decision.reviewUrl, reviewUrl);
  assert.equal(raw._meta["task-authority/decision"].reviewUrl, reviewUrl);
  assert.match(raw.statusMessage, /\/approve\?r=/);
});

test("stored tool history is sanitized only for Auth0 approval results", () => {
  const approval = {
    taskId: "apr_123",
    status: "working",
    statusMessage: `Waiting: ${reviewUrl}`,
    _meta: {
      "task-authority/decision": {
        reasonCode: "auth0_passkey_approval",
        reviewUrl,
      },
    },
  };
  const authority = {
    taskId: "op_123",
    status: "working",
    statusMessage: "Review at https://policy-desk.test/review?approval=apr_1",
    _meta: {
      "task-authority/decision": {
        reasonCode: "task_authority_approval",
        reviewUrl: "https://policy-desk.test/review?approval=apr_1",
      },
    },
  };
  const history: any[] = [
    { role: "tool", tool_call_id: "a", content: JSON.stringify(approval) },
    { role: "tool", tool_call_id: "b", content: JSON.stringify(authority) },
    { role: "assistant", content: "Unrelated prior reply." },
  ];

  const safe = modelFacingHistory(history);
  assert.equal(JSON.stringify(safe[0]).includes(token), false);
  const safeAuthority = safe[1];
  assert.equal(safeAuthority?.role, "tool");
  if (safeAuthority?.role === "tool")
    assert.equal(
      JSON.parse(safeAuthority.content).statusMessage,
      authority.statusMessage,
    );
  assert.equal(safe[2], history[2]);
  assert.equal(
    JSON.parse(history[0]!.content).statusMessage,
    approval.statusMessage,
  );
});

test("finished Auth0 approval tasks keep their outcome for the model", () => {
  const done = {
    taskId: "apr_123",
    status: "completed",
    statusMessage: "Refund issued after a passkey approval.",
    _meta: {
      "task-authority/decision": {
        decision: "approval_required",
        reasonCode: "auth0_passkey_approval",
        approvalId: "apr_123",
      },
    },
  };
  const modelCopy = modelFacingToolResult(done) as Record<string, any>;
  assert.equal(modelCopy.statusMessage, done.statusMessage);
});
