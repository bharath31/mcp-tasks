import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import {
  CLAIM_DENIAL_CODES,
  ERROR_CODES,
  EVENT_TYPES,
  claimRequestSchema,
  createDelegationSchema,
  decisionSchema,
  registerOperationSchema,
} from "@task-authority/contracts";
import { ServiceError } from "../../service/src/errors.js";
import { routeTable } from "../../service/src/http.js";
import {
  canonicalDocument,
  canonicalize,
  sha256,
} from "../../service/src/operations.js";
import { buildOpenApi } from "../../tools/generate-openapi.js";

const PRD_ERROR_CODES = [
  "invalid_identity",
  "invalid_tenant",
  "not_authorized",
  "delegation_not_found",
  "delegation_expired",
  "delegation_revoked",
  "approval_required",
  "approval_pending",
  "approval_rejected",
  "approval_expired",
  "approver_ineligible",
  "operation_conflict",
  "operation_changed",
  "authorization_unavailable",
  "claim_conflict",
  "reconcile_required",
  "provider_outcome_unknown",
  "rate_limited",
];
const PRD_EVENTS = [
  "delegation.created",
  "delegation.revoked",
  "operation.registered",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  "authorization.allowed",
  "authorization.denied",
  "claim.created",
  "claim.recovered",
  "claim.reconciliation_required",
  "outcome.reported",
];

const sources = () => {
  const dir = new URL("../../service/src/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(new URL(f, dir), "utf8"))
    .join("\n");
};

test("error contract covers every code the PRD requires, each with an HTTP status and retry hint", () => {
  for (const c of PRD_ERROR_CODES)
    assert.ok((ERROR_CODES as readonly string[]).includes(c), c);
  for (const code of ERROR_CODES) {
    const e = new ServiceError(code);
    assert.ok(e.status >= 400 && e.status < 600, code);
    assert.equal(typeof e.retryable, "boolean");
  }
  assert.ok(new ServiceError("authorization_unavailable").retryable);
  assert.ok(!new ServiceError("delegation_revoked").retryable);
  for (const c of CLAIM_DENIAL_CODES)
    assert.ok((ERROR_CODES as readonly string[]).includes(c));
});

test("versioned event vocabulary includes every PRD event and the service emits each of them", () => {
  const src = sources();
  for (const ev of PRD_EVENTS) {
    assert.ok((EVENT_TYPES as readonly string[]).includes(ev), ev);
    assert.ok(src.includes(`"${ev}"`), `${ev} is never emitted`);
  }
  for (const [, ev] of src.matchAll(/type: "([a-z]+\.[a-z_]+)"/g))
    assert.ok(
      (EVENT_TYPES as readonly string[]).includes(ev!),
      `undeclared event ${ev}`,
    );
});

test("request schemas are strict: unknown fields, bad digests and lifetimes are rejected", () => {
  const good = {
    ownerType: "organization",
    organizationId: "org_northstar",
    agentId: "agent_returns",
    resource: "merchant:org_northstar/refunds",
    actions: ["refund:create"],
    expiresAt: "2026-10-15T09:00:00Z",
  };
  assert.ok(createDelegationSchema.safeParse(good).success);
  assert.ok(
    !createDelegationSchema.safeParse({ ...good, tenantId: "t" }).success,
    "tenant is never accepted from the body",
  );
  assert.ok(
    !createDelegationSchema.safeParse({ ...good, actions: [] }).success,
  );
  assert.ok(
    !createDelegationSchema.safeParse({ ...good, expiresAt: "tomorrow" })
      .success,
  );
  assert.ok(
    !decisionSchema.safeParse({
      decision: "approve",
      operationDigest: "md5:abc",
    }).success,
  );
  assert.ok(
    !decisionSchema.safeParse({
      decision: "approved",
      operationDigest: `sha256:${"a".repeat(64)}`,
    }).success,
  );
  assert.ok(
    !claimRequestSchema.safeParse({
      operationDigest: `sha256:${"a".repeat(64)}`,
      executionKey: "k",
      extra: 1,
    }).success,
  );
  const op = {
    delegationId: "dlg_1",
    operationKey: "k",
    action: "refund:create",
    resource: "payment:742",
    arguments: { amountMinor: 1 },
    approvalAssertion: "none",
  };
  assert.ok(registerOperationSchema.safeParse(op).success);
  assert.ok(
    registerOperationSchema.safeParse({ ...op, approvalAssertion: undefined })
      .success,
    "the service evaluates policy when the customer assertion is omitted",
  );
  assert.ok(
    !registerOperationSchema.safeParse({ ...op, userId: "auth0|x" }).success,
    "no raw user id field exists",
  );
});

test("canonical form v1 is stable: sorted keys, integers only, golden digest", async () => {
  assert.equal(
    canonicalize({ b: 1, a: { d: [3, 2], c: "x" } }),
    '{"a":{"c":"x","d":[3,2]},"b":1}',
  );
  assert.throws(() => canonicalize({ amount: 1.5 }), /safe integers/);
  assert.throws(
    () => canonicalize({ amount: Number.MAX_SAFE_INTEGER + 2 }),
    /safe integers/,
  );
  const doc = canonicalDocument({
    tenantId: "tnt_demo",
    organizationId: "org_northstar",
    delegationId: "dlg_1",
    operationKey: "k",
    action: "refund:create",
    scope: "merchant:org_northstar/refunds",
    resource: "payment:742",
    businessStateVersion: null,
    arguments: {
      paymentId: "pi_test_742",
      orderId: "742",
      merchant: "org_northstar",
      destination: "original_payment_method",
      currency: "USD",
      amountMinor: 15000,
    },
  });
  // Independently computed with node:crypto over the same documented canonical bytes.
  assert.equal(
    await sha256(doc),
    "sha256:289e9ca20719265022e7a4630074e64ae5375a2bfd4f56315ee9b00041d7184e",
  );
});

test("OpenAPI document is generated from the live route table and matches the committed file", () => {
  const committed = JSON.parse(
    readFileSync(
      new URL("../../service/openapi.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildOpenApi())));
  for (const r of routeTable) {
    const path = r.template.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
    const op = committed.paths[path]?.[r.method.toLowerCase()];
    assert.ok(op, `${r.method} ${path} documented`);
    assert.equal(Boolean(op.requestBody), r.hasBody, path);
    assert.equal(
      op.parameters.some((p: { name: string }) => p.name === "Idempotency-Key"),
      r.idempotent,
      path,
    );
  }
  assert.ok(committed.paths["/healthz"]);
  assert.ok(committed.paths["/v1/policies/{resourceServer}"]);
  assert.ok(
    committed.paths["/v1/policies/{resourceServer}"].put.parameters.some(
      (p: { name: string; required?: boolean }) =>
        p.name === "resourceServer" && p.required,
    ),
  );
  assert.deepEqual(committed.components.schemas.ApiError.properties.code.enum, [
    ...ERROR_CODES,
  ]);
});

test("the eleven PRD v1 endpoints exist (plus operation cancel)", () => {
  const have = new Set(routeTable.map((r) => `${r.method} ${r.template}`));
  for (const e of [
    "POST /v1/delegations",
    "GET /v1/delegations/:id",
    "POST /v1/delegations/:id/revoke",
    "POST /v1/operations",
    "GET /v1/operations/:id",
    "POST /v1/operations/:id/approval-requests",
    "GET /v1/approval-requests/:id",
    "POST /v1/approval-requests/:id/decisions",
    "POST /v1/operations/:id/claims",
    "POST /v1/operations/:id/outcomes",
    "GET /v1/operations/:id/audit",
  ])
    assert.ok(have.has(e), e);
});
