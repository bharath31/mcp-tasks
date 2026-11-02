import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Agent, fetch as undiciFetch } from "undici";
import { MFA_CODE } from "../../../auth0/tests/helpers/oidc-server.js";
import { ORIGIN, startWorld, type World } from "./helpers/world.js";

let w: World;
let alice: string;
let sandboxId: string;
let agent: Agent;
let pool: Awaited<ReturnType<World["pool"]>>;
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/tasks": {} },
  },
};

before(async () => {
  w = await startWorld();
  pool = w.pool();
  alice = await w.login("alice");
  sandboxId = (await w.call("POST", "/sandbox/reset", alice, {})).json
    .sandboxId;
  w.env.APPROVAL_MODE = "approve";
  w.env.APPROVAL_CLIENT_ID = "approvals";
  w.env.APPROVAL_CLIENT_SECRET = "approval-secret";
  w.env.APP_URL = ORIGIN;
  agent = new Agent({ connect: { ca: readFileSync(w.oidc.caPath) } });
  w.env.APPROVAL_FETCH = ((u: string | URL | Request, init?: RequestInit) =>
    undiciFetch(u as string, {
      ...(init as any),
      dispatcher: agent,
    })) as unknown as typeof fetch;
});

after(async () => {
  agent?.close();
  await pool?.end();
  await w?.close();
});

async function mcp(
  method: string,
  params: Record<string, unknown>,
  idempotencyKey?: string,
) {
  const response = await w.raw("/mcp", {
    method: "POST",
    token: alice,
    headers: {
      "x-policy-desk-sandbox": sandboxId,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: META },
    }),
  });
  return { status: response.status, json: (await response.json()) as any };
}

async function requestTask(orderId: string, amountMinor = 1000) {
  const response = await mcp("tools/call", {
    name: "request_refund",
    arguments: { orderId, amountMinor, reason: "Approval mode test" },
  });
  assert.equal(
    response.json.result.resultType,
    "task",
    JSON.stringify(response.json),
  );
  assert.equal(response.json.result.status, "working");
  const task = response.json.result as {
    taskId: string;
    statusMessage: string;
    _meta: { "task-authority/decision": { reviewUrl?: string } };
  };
  assertApprovalReviewUrl(task._meta["task-authority/decision"].reviewUrl);
  return task;
}

function assertApprovalReviewUrl(value: unknown) {
  assert.equal(typeof value, "string");
  const url = new URL(value as string);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, "/approve");
  assert.ok(url.searchParams.get("r"));
}

async function decide(
  task: { taskId: string; statusMessage: string; _meta?: unknown },
  user: string,
  decision: "approve" | "reject",
) {
  const link = task.statusMessage.match(/https?:\/\/\S+/)?.[0];
  assert.ok(link, task.statusMessage);
  const pageUrl = new URL(link);
  const page = await w.app.fetch(new Request(link), w.env);
  assert.equal(page?.status, 200);
  const form = new URLSearchParams({
    r: pageUrl.searchParams.get("r")!,
    decision,
  });
  const started = await w.app.fetch(
    new Request(`${ORIGIN}/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    }),
    w.env,
  );
  assert.equal(started.status, 303);
  const authorize = new URL(started.headers.get("location")!);
  const login = await undiciFetch(`${w.oidc.issuer}authorize`, {
    method: "POST",
    body: new URLSearchParams({
      ...Object.fromEntries(authorize.searchParams),
      _user: user,
      _method: "passkey",
      _mfa: MFA_CODE,
    }),
    redirect: "manual",
    dispatcher: agent,
  });
  assert.equal(login.status, 302);
  const callback = await w.app.fetch(
    new Request(login.headers.get("location")!),
    w.env,
  );
  return callback;
}

async function orderId(customer: string) {
  const orders = (await w.call("GET", "/sandbox/orders", alice)).json.orders;
  const found = orders.find((order: any) => order.customer === customer);
  assert.ok(found);
  return found.orderId as string;
}

describe("Policy Desk Auth0-signed approval mode", () => {
  it("rejects a wrong approver, approves once, and returns the same completed task on replay", async () => {
    const task = await requestTask(await orderId("Mei Tanaka"), 1000);
    const waiting = await mcp("tasks/get", { taskId: task.taskId });
    assert.equal(waiting.json.result.status, "working");
    assertApprovalReviewUrl(
      waiting.json.result._meta["task-authority/decision"].reviewUrl,
    );
    const wrongUser = await decide(task, "alice", "approve");
    assert.equal(wrongUser.status, 403);

    const approved = await decide(task, "bob", "approve");
    assert.equal(approved.status, 200);
    const first = await mcp("tasks/get", { taskId: task.taskId });
    assert.equal(
      first.json.result.status,
      "completed",
      JSON.stringify(first.json),
    );
    assert.equal(
      first.json.result.result.structuredContent.outcome,
      "refunded",
    );
    const second = await mcp("tasks/get", { taskId: task.taskId });
    assert.equal(second.json.result.status, "completed");
    assert.equal(
      (await w.call("GET", "/sandbox/orders", alice)).json.orders.find(
        (o: any) => o.customer === "Mei Tanaka",
      ).refundedMinor,
      1000,
    );
  });

  it("records a signed rejection and reports an expired request", async () => {
    const rejected = await requestTask(await orderId("Kwame Mensah"), 1000);
    const callback = await decide(rejected, "bob", "reject");
    assert.equal(callback.status, 200);
    const failed = await mcp("tasks/get", { taskId: rejected.taskId });
    assert.equal(failed.json.result.status, "failed");
    assert.equal(failed.json.result.error.message, "approval_rejected");

    const expired = await requestTask(await orderId("Dana Whitfield"), 1000);
    await pool.query(
      "update policy_desk.approval_requests set expires_at=now()-interval '1 second' where id=$1",
      [expired.taskId],
    );
    const out = await mcp("tasks/get", { taskId: expired.taskId });
    assert.equal(out.json.result.status, "failed");
    assert.equal(out.json.result.error.message, "approval_expired");
  });

  it("reuses the same waiting task for an idempotent retry and rejects changed details", async () => {
    const id = await orderId("Dana Whitfield");
    const idem = "approval-retry-0001";
    const args = {
      name: "request_refund",
      arguments: { orderId: id, amountMinor: 1200, reason: "Same retry" },
    };
    const first = await mcp("tools/call", args, idem);
    const replay = await mcp("tools/call", args, idem);
    assert.equal(replay.json.result.taskId, first.json.result.taskId);
    const changed = await mcp(
      "tools/call",
      {
        name: "request_refund",
        arguments: { orderId: id, amountMinor: 1300, reason: "Changed" },
      },
      idem,
    );
    assert.equal(changed.json.result.isError, true);
    assert.equal(
      JSON.parse(changed.json.result.content[0].text).outcome,
      "idempotency_conflict",
    );
  });
});
