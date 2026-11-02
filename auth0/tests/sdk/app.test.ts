import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createTaskAuthority,
  resolveConfig,
  type OperationView,
} from "@task-authority/sdk";

const operation = (extra: Partial<OperationView> = {}): OperationView => ({
  id: "op_1",
  tenantId: "t",
  organizationId: "org_1",
  delegationId: null,
  operationKey: "refund:create:k1",
  taskId: null,
  action: "refund:create",
  resource: "payment:pi_1",
  canonicalVersion: 1,
  digest: "sha256:exact",
  approvalRequirement: "none",
  status: "registered",
  businessStateVersion: null,
  expiresAt: "2030-01-01T00:00:00Z",
  correlationId: "cor",
  approvalId: null,
  approvalStatus: null,
  claim: null,
  decision: "allow",
  reasonCode: "policy_allowed",
  ruleIds: ["small"],
  policyVersion: "v1",
  ...extra,
});

/** Fake Auth0 token endpoint plus Task Authority, recording every request. */
function fakeBackend(op: OperationView) {
  const requests: Array<{ url: string; auth?: string; body: any }> = [];
  let tokens = 0;
  const fetch: typeof globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === "https://tenant.auth0.test/oauth/token") {
      tokens++;
      return Response.json({
        access_token: `token-for-${body.client_id}`,
        expires_in: 3600,
      });
    }
    const headers = new Headers(init?.headers);
    requests.push({
      url: new URL(url).pathname,
      auth: headers.get("authorization") ?? undefined,
      body,
    });
    if (url.endsWith("/claims"))
      return Response.json({
        decision: "authorized",
        claimId: "cl_1",
        operationId: op.id,
      });
    if (url.endsWith("/approval-requests"))
      return Response.json({ id: "ap_1", status: "pending" });
    if (url.endsWith("/outcomes"))
      return Response.json({ operationId: op.id, claimId: "cl_1" });
    return Response.json(op);
  }) as typeof globalThis.fetch;
  return { fetch, requests, tokens: () => tokens };
}

const env = {
  TASK_AUTHORITY_URL: "https://authority.test",
  TASK_AUTHORITY_RESOURCE_SERVER: "https://refunds.example/api",
  TASK_AUTHORITY_ORGANIZATION: "org_1",
  TASK_AUTHORITY_REVIEW_URL:
    "https://refunds.example/review?approval={approvalId}",
  AUTH0_DOMAIN: "tenant.auth0.test",
  TASK_AUTHORITY_AUDIENCE: "https://authority.test/",
  TASK_AUTHORITY_CLIENT_ID: "api",
  TASK_AUTHORITY_CLIENT_SECRET: "api-secret",
  TASK_AUTHORITY_EXECUTOR_CLIENT_ID: "executor",
  TASK_AUTHORITY_EXECUTOR_CLIENT_SECRET: "executor-secret",
};

type Refund = { paymentId: string; amountMinor: number };

test("an action configured from the environment registers, claims as the executor, runs and reports", async () => {
  const backend = fakeBackend(operation());
  const authority = createTaskAuthority({ env, fetch: backend.fetch });
  const seen: string[] = [];
  const refund = authority.action("refund:create", {
    resource: (r: Refund) => `payment:${r.paymentId}`,
    facts: () => ({ refundableMinor: 1000 }),
    run: async (r, { key, claim }) => {
      seen.push(key, claim.claimId, String(r.amountMinor));
      return { id: "re_1" };
    },
  });

  const outcome = await refund(
    { paymentId: "pi_1", amountMinor: 500 },
    { user: "user-token", key: "refund:create:k1" },
  );

  assert.equal(outcome.executed, true);
  assert.deepEqual(outcome.result, { id: "re_1" });
  assert.deepEqual(seen, ["refund:create:k1", "cl_1", "500"]);
  const [register, claim, report] = backend.requests;
  assert.equal(register!.url, "/v1/operations");
  assert.deepEqual(register!.body, {
    operationKey: "refund:create:k1",
    resource: "payment:pi_1",
    arguments: { paymentId: "pi_1", amountMinor: 500 },
    resourceServer: "https://refunds.example/api",
    organizationId: "org_1",
    facts: { refundableMinor: 1000 },
    action: "refund:create",
  });
  assert.equal(register!.auth, "Bearer token-for-api");
  assert.equal(claim!.url, "/v1/operations/op_1/claims");
  assert.equal(claim!.auth, "Bearer token-for-executor");
  assert.equal(report!.url, "/v1/operations/op_1/outcomes");
  assert.equal(report!.body.providerStatus, "succeeded");
  assert.equal(report!.body.providerReference, "re_1");
  assert.equal(backend.tokens(), 2, "one cached token per client");

  const res = outcome.toResponse();
  assert.equal(res.status, 201);
  assert.equal(Object.keys(outcome).includes("toResponse"), false);
});

test("an approval stops before the side effect and links the configured review page", async () => {
  const backend = fakeBackend(
    operation({ approvalRequirement: "human", decision: "approval_required" }),
  );
  const authority = createTaskAuthority({ env, fetch: backend.fetch });
  let ran = false;
  const refund = authority.action("refund:create", {
    resource: (r: Refund) => `payment:${r.paymentId}`,
    run: async () => {
      ran = true;
    },
  });
  const outcome = await refund({ paymentId: "pi_1", amountMinor: 90_000 });
  assert.equal(ran, false);
  assert.equal(outcome.decision, "approval_required");
  assert.equal(
    outcome.reviewUrl,
    "https://refunds.example/review?approval=ap_1",
  );
  const res = outcome.toResponse();
  assert.equal(res.status, 202);
  assert.equal(outcome.toMcp().status, "working");
  assert.equal(outcome.toCli().exitCode, 0);
});

test("a throwing side effect is reported unknown, and a callback that reports is left alone", async () => {
  const backend = fakeBackend(operation());
  const authority = createTaskAuthority({ env, fetch: backend.fetch });
  const failing = authority.action("refund:create", {
    resource: (r: Refund) => `payment:${r.paymentId}`,
    run: async () => {
      throw new Error("provider_timeout");
    },
  });
  await assert.rejects(
    failing({ paymentId: "pi_1", amountMinor: 1 }),
    /provider_timeout/,
  );
  assert.equal(backend.requests.at(-1)!.body.providerStatus, "unknown");

  const before = backend.requests.length;
  const selfReporting = authority.action("refund:create", {
    resource: (r: Refund) => `payment:${r.paymentId}`,
    run: async (_r, { claim }) => {
      await claim.report("pending", "re_2");
      return { id: "re_2" };
    },
  });
  await selfReporting({ paymentId: "pi_1", amountMinor: 1 });
  const reports = backend.requests
    .slice(before)
    .filter((r) => r.url.endsWith("/outcomes"));
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.body.providerStatus, "pending");
});

test("resume runs a registered operation and refuses input for another resource", async () => {
  const backend = fakeBackend(
    operation({
      approvalStatus: "approved",
      arguments: { paymentId: "pi_1", amountMinor: 1 },
    }),
  );
  const authority = createTaskAuthority({ env, fetch: backend.fetch });
  const refund = authority.action("refund:create", {
    resource: (r: Refund) => `payment:${r.paymentId}`,
    run: async () => ({ id: "re_3" }),
  });
  await assert.rejects(
    refund.resume("op_1", { paymentId: "pi_other", amountMinor: 1 }),
    /resume_input_mismatch/,
  );
  // Same resource, different amount: the approval covers the registered arguments only.
  await assert.rejects(
    refund.resume("op_1", { paymentId: "pi_1", amountMinor: 999_999 }),
    /resume_input_mismatch/,
  );
  const outcome = await refund.resume("op_1", {
    amountMinor: 1,
    paymentId: "pi_1",
  });
  assert.equal(outcome.executed, true);
  assert.equal(
    backend.requests.filter((r) => r.url === "/v1/operations").length,
    0,
    "resume never registers",
  );
  assert.equal(
    backend.requests.filter((r) => r.url.endsWith("/claims")).length,
    1,
    "a mismatched resume never claims",
  );
});

test("resume refuses when the service does not return the registered arguments", async () => {
  const backend = fakeBackend(operation({ approvalStatus: "approved" }));
  const authority = createTaskAuthority({ env, fetch: backend.fetch });
  let ran = false;
  const refund = authority.action("refund:create", {
    resource: (r: Refund) => `payment:${r.paymentId}`,
    run: async () => {
      ran = true;
      return { id: "re_4" };
    },
  });
  await assert.rejects(
    refund.resume("op_1", { paymentId: "pi_1", amountMinor: 1 }),
    /resume_input_mismatch/,
  );
  assert.equal(ran, false);
});

test("config precedence is code, then environment, then task-authority.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "ta-config-"));
  const file = join(dir, "task-authority.json");
  writeFileSync(
    file,
    JSON.stringify({
      url: "https://from-file.test",
      resourceServer: "https://file.example/api",
      reviewUrl: "https://file.example/review?approval={approvalId}",
    }),
  );
  const c = resolveConfig({
    configFile: file,
    env: { TASK_AUTHORITY_RESOURCE_SERVER: "https://env.example/api" },
    organizationId: "org_code",
  });
  assert.equal(c.url, "https://from-file.test");
  assert.equal(c.resourceServer, "https://env.example/api");
  assert.equal(
    c.reviewUrl,
    "https://file.example/review?approval={approvalId}",
  );
  assert.equal(c.organizationId, "org_code");
  assert.throws(() => resolveConfig({ env: {} }), /TASK_AUTHORITY_URL/);
});

test("missing credentials fail with a message naming the settings", async () => {
  const authority = createTaskAuthority({
    env: { TASK_AUTHORITY_URL: "https://authority.test" },
  });
  const noop = authority.action("refund:create", {
    resource: () => "payment:1",
    run: async () => null,
  });
  await assert.rejects(
    noop({}),
    /AUTH0_DOMAIN, TASK_AUTHORITY_AUDIENCE, TASK_AUTHORITY_CLIENT_ID/,
  );
});
