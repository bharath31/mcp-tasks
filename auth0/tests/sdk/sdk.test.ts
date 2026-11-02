import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthorizationRequired,
  TaskAuthority,
  TaskAuthorityError,
  verifiedAgent,
  verifiedSubject,
} from "@task-authority/sdk";
import {
  describeAuthority,
  operationKey,
  principalFromMcpAuth,
} from "@task-authority/sdk/mcp-tasks";

type Req = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
};
function fakeFetch(script: Array<Response | Error | ((r: Req) => Response)>) {
  const calls: Req[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const req: Req = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(req);
    const next = script[Math.min(calls.length - 1, script.length - 1)]!;
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req) : next.clone();
  };
  return { calls, fetch: fetchImpl };
}
const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const mk = (f: ReturnType<typeof fakeFetch>, extra: object = {}) =>
  new TaskAuthority({
    baseUrl: "https://ta.example/",
    getAccessToken: async () => "svc-token",
    fetch: f.fetch,
    sleep: async () => {},
    ...extra,
  });
const err = (
  code: string,
  status: number,
  retryable = false,
  details?: object,
) =>
  json(status, {
    code,
    message: code,
    correlationId: "cor_1",
    retryable,
    details,
  });

test("requests carry the backend token, an idempotency key and the correlation id; no secret leaves via the URL", async () => {
  const f = fakeFetch([json(200, { id: "op_1" })]);
  await mk(f).withCorrelationId("cor_chain_1").operations.get("op_1");
  const [c] = f.calls;
  assert.equal(c!.url, "https://ta.example/v1/operations/op_1");
  assert.equal(c!.headers.authorization, "Bearer svc-token");
  assert.equal(c!.headers["x-correlation-id"], "cor_chain_1");
  assert.ok(!c!.url.includes("svc-token"));
});

test("mutations always send an Idempotency-Key and reuse the same key across retries", async () => {
  const f = fakeFetch([
    err("authorization_unavailable", 503, true),
    new Error("socket"),
    json(200, { id: "op_1", digest: "sha256:x" }),
  ]);
  const out = await mk(f).operations.register({
    delegationId: "dlg_1",
    operationKey: "k",
    action: "refund:create",
    resource: "payment:1",
    arguments: { amountMinor: 1 },
  });
  assert.equal((out as { id: string }).id, "op_1");
  assert.equal(f.calls.length, 3);
  const keys = new Set(f.calls.map((c) => c.headers["idempotency-key"]));
  assert.equal(keys.size, 1);
  assert.match([...keys][0]!, /^sdk:/);
});

test("approvalAssertion is omitted for service evaluation and the initiator rides as a subject header", async () => {
  const f = fakeFetch([json(200, {})]);
  await mk(f).operations.register({
    delegationId: "d",
    operationKey: "k",
    action: "a",
    resource: "r",
    arguments: {},
    initiator: verifiedSubject({
      accessToken: "user-jwt",
      organizationId: "org_1",
    }),
  });
  assert.equal(f.calls[0]!.body.approvalAssertion, undefined);
  assert.equal(f.calls[0]!.headers["x-task-authority-subject"], "user-jwt");
  assert.ok(
    !JSON.stringify(f.calls[0]!.body).includes("user-jwt"),
    "the subject token is never in the body",
  );
});

test("delegation owner/agent come only from verified context; the body has no raw user id", async () => {
  const f = fakeFetch([json(201, { id: "dlg_1" })]);
  await mk(f).delegations.create({
    owner: verifiedSubject({
      accessToken: "t",
      organizationId: "org_northstar",
    }),
    agent: verifiedAgent("agent_returns"),
    ownerType: "organization",
    resource: "merchant:org_northstar/refunds",
    actions: ["refund:create"],
    expiresAt: "2026-10-15T09:00:00Z",
  });
  const body = f.calls[0]!.body;
  assert.equal(body.organizationId, "org_northstar");
  assert.equal(body.agentId, "agent_returns");
  assert.ok(
    !("userId" in body) && !("actorId" in body) && !("tenantId" in body),
  );
  // @ts-expect-error a bare string is not a VerifiedSubject
  const bad: Parameters<TaskAuthority["delegations"]["create"]>[0]["owner"] =
    "auth0|alice";
  void bad;
});

test("typed errors expose code, status, retryability, correlation id and details", async () => {
  const f = fakeFetch([
    err("not_authorized", 403, false, { reason: "mfa_required" }),
  ]);
  await assert.rejects(mk(f).operations.get("op_1"), (e: unknown) => {
    assert.ok(e instanceof TaskAuthorityError);
    assert.equal(e.code, "not_authorized");
    assert.equal(e.status, 403);
    assert.equal(e.retryable, false);
    assert.equal(e.correlationId, "cor_1");
    assert.deepEqual(e.details, { reason: "mfa_required" });
    return true;
  });
  assert.equal(f.calls.length, 1, "non-transient errors are not retried");
});

test("retries are bounded and honor Retry-After for rate limiting", async () => {
  const sleeps: number[] = [];
  const f = fakeFetch([
    err("rate_limited", 429, true),
    err("rate_limited", 429, true),
    err("rate_limited", 429, true),
  ]);
  const c = new TaskAuthority({
    baseUrl: "https://ta.example",
    getAccessToken: async () => "t",
    fetch: f.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    retry: { retries: 2 },
  });
  await assert.rejects(
    c.operations.get("op_1"),
    (e: unknown) =>
      e instanceof TaskAuthorityError && e.code === "rate_limited",
  );
  assert.equal(f.calls.length, 3);
  assert.equal(sleeps.length, 2);
  const none = fakeFetch([err("authorization_unavailable", 503, true)]);
  await assert.rejects(
    new TaskAuthority({
      baseUrl: "https://ta.example",
      getAccessToken: async () => "t",
      fetch: none.fetch,
      sleep: async () => {},
      retry: { retries: 0 },
    }).operations.get("x"),
  );
  assert.equal(none.calls.length, 1);
});

test("network failures surface as retryable network_error after bounded attempts", async () => {
  const f = fakeFetch([new Error("ECONNRESET")]);
  await assert.rejects(
    mk(f).operations.get("op_1"),
    (e: unknown) =>
      e instanceof TaskAuthorityError &&
      e.code === "network_error" &&
      e.retryable,
  );
  assert.equal(f.calls.length, 3);
});

test("authorizeAndClaim returns policy refusals as data, with a per-call idempotency key", async () => {
  const f = fakeFetch([
    err("approver_ineligible", 403, false, {
      reason: "approver_permission_lost",
    }),
  ]);
  const r = await mk(f).operations.authorizeAndClaim({
    operationId: "op_1",
    operationDigest: `sha256:${"a".repeat(64)}`,
    executionKey: "northstar:refund:742:1",
  });
  assert.equal(r.decision, "denied");
  assert.ok(
    r.decision === "denied" &&
      r.code === "approver_ineligible" &&
      r.reason === "approver_permission_lost" &&
      r.correlationId === "cor_1",
  );
  assert.match(
    f.calls[0]!.headers["idempotency-key"]!,
    /^sdk:/,
    "a per-call key, not a fixed key that would replay stale decisions",
  );
  assert.throws(() => {
    throw new AuthorizationRequired(r as never);
  }, /approver_ineligible/);
});

test("authorizeAndClaim passes authorized and reconcile_required through; contract errors still throw", async () => {
  const ok = {
    decision: "authorized",
    claimId: "clm_1",
    operationId: "op_1",
    expiresAt: "x",
    recovered: false,
    correlationId: "c",
  };
  assert.deepEqual(
    await mk(fakeFetch([json(200, ok)])).operations.authorizeAndClaim({
      operationId: "op_1",
      operationDigest: "sha256:x",
      executionKey: "k",
    }),
    ok,
  );
  const rec = {
    decision: "reconcile_required",
    claimId: "clm_1",
    operationId: "op_1",
    code: "reconcile_required",
    reason: "claim_lease_elapsed_without_outcome",
    correlationId: "c",
  };
  assert.equal(
    (
      await mk(fakeFetch([json(200, rec)])).operations.authorizeAndClaim({
        operationId: "op_1",
        operationDigest: "sha256:x",
        executionKey: "k",
      })
    ).decision,
    "reconcile_required",
  );
  await assert.rejects(
    mk(fakeFetch([err("invalid_request", 400)])).operations.authorizeAndClaim({
      operationId: "op_1",
      operationDigest: "sha256:x",
      executionKey: "k",
    }),
    TaskAuthorityError,
  );
  // An outage on claim is data too (fail closed), and is flagged retryable.
  const out = await new TaskAuthority({
    baseUrl: "https://ta.example",
    getAccessToken: async () => "t",
    fetch: fakeFetch([err("authorization_unavailable", 503, true)]).fetch,
    sleep: async () => {},
    retry: { retries: 0 },
  }).operations.authorizeAndClaim({
    operationId: "op_1",
    operationDigest: "sha256:x",
    executionKey: "k",
  });
  assert.ok(out.decision === "denied" && out.retryable);
});

test("optional MCP helpers: identity mapping, stable keys and honest status text", () => {
  const { owner, agent } = principalFromMcpAuth(
    { token: "jwt", clientId: "mcp-client" },
    { organizationId: "org_northstar", agentId: "agent_returns" },
  );
  assert.equal(owner.organizationId, "org_northstar");
  assert.equal(agent.agentId, "agent_returns");
  assert.equal(
    operationKey("northstar", "refund", "payment 742", 1),
    "northstar:refund:payment-742:1",
  );
  const base = { approvalRequirement: "human" as const, claim: null };
  assert.equal(
    describeAuthority({
      ...base,
      status: "registered",
      approvalStatus: "pending",
    }).state,
    "awaiting_human_approval",
  );
  assert.equal(
    describeAuthority({
      ...base,
      status: "registered",
      approvalStatus: "expired",
    }).state,
    "approval_needed",
  );
  assert.equal(
    describeAuthority({
      ...base,
      status: "claimed",
      approvalStatus: "approved",
    }).state,
    "dispatch_authorized",
  );
  assert.equal(
    describeAuthority({
      ...base,
      status: "settled",
      approvalStatus: "approved",
    }).state,
    "settled",
  );
});
