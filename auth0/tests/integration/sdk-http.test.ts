import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  TaskAuthority,
  TaskAuthorityError,
  verifiedAgent,
  verifiedSubject,
} from "@task-authority/sdk";
import { listen } from "../../service/src/server.js";
import {
  AGENTS,
  ORG,
  PEOPLE,
  createWorld,
  type World,
} from "../helpers/world.js";

let w: World;
let url: string;
let server: Awaited<ReturnType<typeof listen>>;
before(async () => {
  w = await createWorld();
  server = await listen(w.handle, 0);
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await w.close();
});

const sdk = (token: () => Promise<string>, fetchImpl?: typeof fetch) =>
  new TaskAuthority({
    baseUrl: url,
    getAccessToken: token,
    fetch: fetchImpl,
    retry: { baseDelayMs: 5, maxDelayMs: 20 },
  });

test("customer SDK ↔ separately hosted service over HTTP: exception flow end to end (FR-001, FR-002)", async () => {
  const api = sdk(() => w.tok.api());
  const executor = sdk(() => w.tok.executor());
  const owner = verifiedSubject({
    accessToken: await w.tok.user(PEOPLE.alice, ORG.northstar),
    organizationId: ORG.northstar,
  });

  const delegation = await api.delegations.create({
    owner,
    agent: verifiedAgent(AGENTS.returns),
    ownerType: "user",
    resource: "merchant:org_northstar/refunds",
    actions: ["refund:create"],
    expiresAt: w.iso(48 * 3600_000),
  });
  const operation = await api.operations.register({
    delegationId: delegation.id,
    operationKey: "http:refund:742:1",
    taskId: "task-http-1",
    action: "refund:create",
    resource: "payment:742",
    arguments: {
      merchant: ORG.northstar,
      orderId: "742",
      paymentId: "pi_test_742",
      amountMinor: 15000,
      currency: "USD",
      destination: "original_payment_method",
    },
    approvalAssertion: "human",
    initiator: owner,
  });
  assert.equal(operation.approvalRequirement, "human");
  const approval = await api.approvals.request({
    operationId: operation.id,
    permission: "refund_approve",
    reviewerHint: "morgan@northstar.example",
  });

  const early = await executor.operations.authorizeAndClaim({
    operationId: operation.id,
    operationDigest: operation.digest,
    executionKey: operation.operationKey,
  });
  assert.equal(early.decision, "denied");
  assert.ok(early.decision === "denied" && early.code === "approval_pending");

  const decided = await w.approve(approval.id, operation.digest);
  assert.equal(decided.status, 200);

  const claim = await executor.operations.authorizeAndClaim({
    operationId: operation.id,
    operationDigest: operation.digest,
    executionKey: operation.operationKey,
  });
  assert.equal(claim.decision, "authorized");
  assert.ok(claim.decision === "authorized");
  const outcome = await executor.operations.reportOutcome({
    operationId: operation.id,
    claimId: claim.claimId,
    providerStatus: "succeeded",
    providerReference: "re_test_1",
  });
  assert.equal(outcome.operationStatus, "settled");

  const events = await new TaskAuthority({
    baseUrl: url,
    getAccessToken: () => w.tok.investigator(),
  }).audit.list(operation.id);
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "delegation.created",
      "operation.registered",
      "approval.requested",
      "authorization.denied",
      "approval.approved",
      "authorization.allowed",
      "claim.created",
      "outcome.reported",
    ],
  );
  assert.equal(new Set(events.map((e) => e.correlationId)).size, 1);
});

test("SDK surfaces service refusals as typed errors over the wire", async () => {
  const rogue = sdk(() => w.tok.rogue());
  const owner = verifiedSubject({
    accessToken: await w.tok.user(PEOPLE.alice, ORG.northstar),
    organizationId: ORG.northstar,
  });
  await assert.rejects(
    rogue.delegations.create({
      owner,
      agent: verifiedAgent(AGENTS.returns),
      ownerType: "user",
      resource: "merchant:org_northstar/refunds",
      actions: ["refund:create"],
      expiresAt: w.iso(3600_000),
    }),
    (e: unknown) =>
      e instanceof TaskAuthorityError &&
      e.code === "not_authorized" &&
      e.status === 403 &&
      e.details?.reason === "backend_not_trusted_for_org",
  );
  await assert.rejects(
    sdk(async () => "garbage").operations.get("op_1"),
    (e: unknown) =>
      e instanceof TaskAuthorityError && e.code === "invalid_identity",
  );
});

test("a lost response is retried by the SDK without minting a second delegation or claim", async () => {
  const api = sdk(() => w.tok.api());
  const owner = verifiedSubject({
    accessToken: await w.tok.user(PEOPLE.alice, ORG.northstar),
    organizationId: ORG.northstar,
  });
  let dropped = 0;
  const lossy: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (dropped < 1 && String(input).endsWith("/v1/delegations")) {
      dropped++;
      await res.arrayBuffer();
      throw new TypeError("response lost");
    }
    return res;
  };
  const d = await sdk(() => w.tok.api(), lossy).delegations.create({
    owner,
    agent: verifiedAgent(AGENTS.returns),
    ownerType: "user",
    resource: "merchant:org_northstar/refunds",
    actions: ["refund:create"],
    expiresAt: w.iso(3600_000),
  });
  assert.equal(dropped, 1);
  const count = await w.store.pool.query(
    "select count(*)::int n from authority.delegations where id=$1",
    [d.id],
  );
  assert.equal(count.rows[0].n, 1);
  const total = await w.store.pool.query(
    "select count(*)::int n from authority.audit_events where delegation_id=$1 and type='delegation.created'",
    [d.id],
  );
  assert.equal(total.rows[0].n, 1);

  const op = await api.operations.register({
    delegationId: d.id,
    operationKey: "http:lost:1",
    action: "refund:create",
    resource: "payment:9",
    arguments: { amountMinor: 5000, currency: "USD" },
    approvalAssertion: "none",
  });
  const execKey = op.operationKey;
  const lossyClaim: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (dropped < 2 && String(input).endsWith("/claims")) {
      dropped++;
      await res.arrayBuffer();
      throw new TypeError("response lost");
    }
    return res;
  };
  const claim = await sdk(
    () => w.tok.executor(),
    lossyClaim,
  ).operations.authorizeAndClaim({
    operationId: op.id,
    operationDigest: op.digest,
    executionKey: execKey,
  });
  assert.equal(dropped, 2);
  assert.ok(claim.decision === "authorized");
  const rows = await w.store.pool.query(
    "select count(*)::int n from authority.claims where operation_id=$1",
    [op.id],
  );
  assert.equal(rows.rows[0].n, 1);
  // The idempotent replay returns the original response, not a "recovered" re-evaluation.
  assert.equal(claim.decision === "authorized" && claim.recovered, false);
});

test("CORS is enforced on the wire for browsers, and credentials are never required in the URL", async () => {
  const pre = await fetch(`${url}/v1/approval-requests/x/decisions`, {
    method: "OPTIONS",
    headers: { origin: "https://app.example" },
  });
  assert.equal(pre.status, 204);
  const evil = await fetch(`${url}/healthz`, {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
});
