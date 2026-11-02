import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  AGENTS,
  CLIENTS,
  ORG,
  PEOPLE,
  createWorld,
  type World,
} from "../helpers/world.js";

let w: World;
before(async () => {
  w = await createWorld({ secondTenant: true });
});
after(async () => w.close());

describe("service authentication and tenant binding (FR-004, FR-009)", () => {
  test(`FGA backend under test: ${process.env.OPENFGA_BIN ? "real OpenFGA server (model.fga)" : "in-memory fake (CI default)"}`, async () => {
    assert.equal(w.fga.backend, process.env.OPENFGA_BIN ? "openfga" : "memory");
    // Org-owned grants rely on the computed relation `delegation_grantor: [user] or admin`.
    assert.equal(
      await w.fga.check(
        `user:${PEOPLE.olivia}`,
        "delegation_grantor",
        `organization:${ORG.northstar}`,
      ),
      true,
    );
    assert.equal(
      await w.fga.check(
        `user:${PEOPLE.alice}`,
        "delegation_grantor",
        `organization:${ORG.northstar}`,
      ),
      false,
    );
    assert.equal(
      await w.fga.check(
        `user:${PEOPLE.mallory}`,
        "refund_approve",
        `organization:${ORG.northstar}`,
      ),
      false,
    );
  });
  test("healthz is public, minimal and reachable", async () => {
    const r = await w.call("GET", "/healthz");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ["contract", "status"]);
  });
  test("missing, malformed, wrong-audience, wrong-issuer, foreign-key and expired tokens are all invalid_identity", async () => {
    const good = {
      sub: "svc@clients",
      m2m: true,
      permissions: ["delegations:read"],
    };
    const bad = [
      undefined,
      "not-a-jwt",
      await w.idp.mint({ ...good, audience: "https://other.example/api" }),
      await w.idp.mint({ ...good, issuer: "https://evil.example/" }),
      await w.idp.foreign(good),
      await w.idp.mint({ ...good, iat: w.clock.seconds - 7200 }), // expired an hour ago
    ];
    for (const token of bad) {
      const r = await w.call("GET", "/v1/delegations/dlg_x", { token });
      assert.equal(r.status, 401, String(token).slice(0, 20));
      assert.equal(r.json.code, "invalid_identity");
      assert.match(r.json.correlationId, /^cor_/);
    }
  });
  test("a subject token from a different tenant cannot ride a service token (invalid_tenant)", async () => {
    const r = await w.call("POST", "/v1/delegations", {
      token: await w.tok.api(),
      subject: await w.idp2!.mint({ sub: PEOPLE.alice, orgId: ORG.northstar }),
      body: {
        ownerType: "user",
        organizationId: ORG.northstar,
        agentId: AGENTS.returns,
        resource: "merchant:org_northstar/refunds",
        actions: ["refund:create"],
        expiresAt: w.iso(3600_000),
      },
    });
    assert.equal(r.json.code, "invalid_tenant");
  });
  test("a client-credentials token cannot be used as the human subject", async () => {
    const r = await w.call("POST", "/v1/delegations", {
      token: await w.tok.api(),
      subject: await w.tok.api(),
      body: {
        ownerType: "user",
        organizationId: ORG.northstar,
        agentId: AGENTS.returns,
        resource: "merchant:org_northstar/refunds",
        actions: ["refund:create"],
        expiresAt: w.iso(3600_000),
      },
    });
    assert.equal(r.json.code, "invalid_identity");
  });
  test("unknown fields, bad JSON and oversize bodies are invalid_request without echoing input", async () => {
    const t = await w.tok.api();
    const secret = "SECRET-VALUE-123";
    const a = await w.call("POST", "/v1/delegations", {
      token: t,
      subject: await w.tok.user(PEOPLE.alice, ORG.northstar),
      body: { evil: secret },
    });
    assert.equal(a.json.code, "invalid_request");
    assert.ok(!JSON.stringify(a.json).includes(secret));
    const b = await w.handle(
      new Request("http://authority.test/v1/delegations", {
        method: "POST",
        headers: {
          authorization: `Bearer ${t}`,
          "content-type": "application/json",
        },
        body: "{nope",
      }),
    );
    assert.equal((await b.json()).code, "invalid_request");
    const c = await w.handle(
      new Request("http://authority.test/v1/delegations", {
        method: "POST",
        headers: { authorization: `Bearer ${t}` },
        body: "x".repeat(70_000),
      }),
    );
    assert.equal((await c.json()).code, "invalid_request");
  });
  test("every error carries the documented contract and a correlation id", async () => {
    const r = await w.call("GET", "/v1/operations/op_missing", {
      token: await w.tok.api(),
      headers: { "x-correlation-id": "cor_test_12345" },
    });
    assert.equal(r.status, 404);
    assert.deepEqual(Object.keys(r.json).sort(), [
      "code",
      "correlationId",
      "message",
      "retryable",
    ]);
    assert.equal(r.json.correlationId, "cor_test_12345");
    assert.equal(r.headers.get("x-correlation-id"), "cor_test_12345");
  });
});

describe("delegations (FR-010..013)", () => {
  test("user-owned delegation records verified provenance and a bounded lifetime", async () => {
    const r = await w.delegate({ ownerType: "user" });
    assert.equal(r.status, 201);
    assert.equal(r.json.actorId, PEOPLE.alice);
    assert.equal(r.json.status, "active");
    assert.equal(r.json.ownerType, "user");
    const events = (
      await w.store.pool.query(
        "select type, actor_id from authority.audit_events where delegation_id=$1",
        [r.json.id],
      )
    ).rows;
    assert.deepEqual(
      events.map((e) => e.type),
      ["delegation.created"],
    );
    assert.equal(events[0].actor_id, PEOPLE.alice);
  });
  test("grantor must be a verified subject; org in the token must match the request", async () => {
    const body = {
      ownerType: "user",
      organizationId: ORG.northstar,
      agentId: AGENTS.returns,
      resource: "merchant:org_northstar/refunds",
      actions: ["refund:create"],
      expiresAt: w.iso(3600_000),
    };
    const noSubject = await w.call("POST", "/v1/delegations", {
      token: await w.tok.api(),
      body,
    });
    assert.equal(noSubject.json.code, "invalid_identity");
    const wrongOrg = await w.call("POST", "/v1/delegations", {
      token: await w.tok.api(),
      subject: await w.tok.user(PEOPLE.alice, ORG.southridge),
      body,
    });
    assert.equal(wrongOrg.json.code, "not_authorized");
    assert.equal(wrongOrg.json.details.reason, "grantor_org_mismatch");
    // A forwarded agent token (act or sub_profile=ai_agent) cannot grant in the person's name.
    for (const claims of [
      { act: { sub: "agent|refund-bot" } },
      { sub_profile: "ai_agent" },
    ]) {
      const agent = await w.call("POST", "/v1/delegations", {
        token: await w.tok.api(),
        subject: await w.idp.mint({
          sub: PEOPLE.alice,
          orgId: ORG.northstar,
          claims,
        }),
        body,
      });
      assert.equal(agent.json.code, "invalid_identity", JSON.stringify(claims));
      assert.equal(agent.json.details.reason, "grantor_must_be_human");
    }
  });
  test("lifetime is bounded by the tenant maximum and must be in the future", async () => {
    assert.equal(
      (await w.delegate({ ttlMs: 49 * 3600_000 })).json.code,
      "invalid_request",
    );
    assert.equal(
      (await w.delegate({ ttlMs: -1000 })).json.code,
      "invalid_request",
    );
  });
  test("agents must be registered for the organization; unknown actions are rejected", async () => {
    assert.equal(
      (await w.delegate({ agent: "agent_unregistered" })).json.details.reason,
      "agent_not_registered_for_org",
    );
    assert.equal(
      (await w.delegate({ actions: ["wire:transfer"] })).json.code,
      "invalid_request",
    );
  });
  test("a client that is not a trusted backend for the organization is refused even with every permission", async () => {
    const r = await w.call("POST", "/v1/delegations", {
      token: await w.tok.rogue(),
      subject: await w.tok.user(PEOPLE.alice, ORG.northstar),
      body: {
        ownerType: "user",
        organizationId: ORG.northstar,
        agentId: AGENTS.returns,
        resource: "merchant:org_northstar/refunds",
        actions: ["refund:create"],
        expiresAt: w.iso(3600_000),
      },
    });
    assert.equal(r.json.code, "not_authorized");
    assert.equal(r.json.details.reason, "backend_not_trusted_for_org");
  });
  test("a user without the underlying permission cannot create user-owned authority (Eve)", async () => {
    const r = await w.delegate({ person: PEOPLE.eve });
    assert.equal(r.json.code, "not_authorized");
    assert.equal(r.json.details.reason, "grantor_lacks_permission");
  });
  test("organization-owned grants require org-grant authority (Alice denied, Olivia allowed)", async () => {
    const denied = await w.delegate({
      ownerType: "organization",
      person: PEOPLE.alice,
    });
    assert.equal(denied.json.details.reason, "not_org_delegation_grantor");
    const ok = await w.delegate({
      ownerType: "organization",
      person: PEOPLE.olivia,
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.ownerType, "organization");
  });
  test("denied creation is itself audited with a reason code, not secrets", async () => {
    const rows = (
      await w.store.pool.query(
        "select reason_code, evaluation from authority.audit_events where type='authorization.denied' and reason_code='not_org_delegation_grantor'",
      )
    ).rows;
    assert.ok(rows.length >= 1);
    assert.ok(!JSON.stringify(rows).match(/eyJ|@/));
  });
  test("owner reads their grant; other organizations and non-members get not found", async () => {
    const d = (await w.delegate()).json;
    const own = await w.call("GET", `/v1/delegations/${d.id}`, {
      token: await w.tok.user(PEOPLE.alice, ORG.northstar),
    });
    assert.equal(own.status, 200);
    for (const [p, o] of [
      [PEOPLE.mallory, ORG.southridge],
      [PEOPLE.eve, ORG.northstar],
    ] as const) {
      const r = await w.call("GET", `/v1/delegations/${d.id}`, {
        token: await w.tok.user(p, o),
      });
      assert.equal(r.json.code, "delegation_not_found");
    }
    const otherTenant = await w.idp2!.service(CLIENTS.api, [
      "delegations:read",
    ]);
    assert.equal(
      (await w.call("GET", `/v1/delegations/${d.id}`, { token: otherTenant }))
        .json.code,
      "delegation_not_found",
    );
  });
  test("idempotent creation: same key and body returns the stored response; changed body conflicts", async () => {
    const a = await w.delegate({ idem: "idem-key-delegation-1" });
    const b = await w.delegate({ idem: "idem-key-delegation-1" });
    assert.equal(b.json.id, a.json.id);
    assert.equal(b.headers.get("idempotent-replayed"), "true");
    const c = await w.delegate({
      idem: "idem-key-delegation-1",
      ttlMs: 3600_000,
    });
    // Different expiresAt (and so a different request hash) must conflict.
    assert.equal(c.json.code, "operation_conflict");
  });
  test("revocation is explicit, owner/admin scoped, and idempotent", async () => {
    const d = (await w.delegate()).json;
    const eve = await w.call("POST", `/v1/delegations/${d.id}/revoke`, {
      token: await w.tok.user(PEOPLE.eve, ORG.northstar),
      body: {},
    });
    assert.equal(eve.json.code, "not_found");
    const admin = await w.call("POST", `/v1/delegations/${d.id}/revoke`, {
      token: await w.tok.user(PEOPLE.olivia, ORG.northstar),
      body: { reason: "policy" },
    });
    assert.equal(admin.status, 200);
    assert.equal(admin.json.status, "revoked");
    const again = await w.call("POST", `/v1/delegations/${d.id}/revoke`, {
      token: await w.tok.user(PEOPLE.alice, ORG.northstar),
      body: {},
    });
    assert.equal(again.json.status, "revoked");
    assert.equal(again.json.revokedAt, admin.json.revokedAt);
  });
});

describe("operations (FR-018..020)", () => {
  test("registration is idempotent on the business key, independent of the MCP task id", async () => {
    const d = (await w.delegate()).json;
    const a = await w.register(d.id, {
      key: "k:refund:742:1",
      taskId: "task-A",
    });
    const b = await w.register(d.id, {
      key: "k:refund:742:1",
      taskId: "task-B",
    });
    assert.equal(a.status, 200);
    assert.equal(b.json.id, a.json.id);
    assert.equal(b.json.taskId, "task-A");
    assert.equal(b.json.digest, a.json.digest);
    assert.match(a.json.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(a.json.canonicalVersion, 1);
  });
  test("argument order does not change the digest; any protected change does", async () => {
    const d = (await w.delegate()).json;
    const args = {
      merchant: ORG.northstar,
      orderId: "742",
      paymentId: "pi_1",
      amountMinor: 5000,
      currency: "USD",
      destination: "original_payment_method",
    };
    const reordered = Object.fromEntries(Object.entries(args).reverse());
    const a = await w.register(d.id, { key: "k:digest:1", args });
    const sameDigest = await w.call("POST", "/v1/operations", {
      token: await w.tok.api(),
      body: {
        delegationId: d.id,
        operationKey: "k:digest:1",
        action: "refund:create",
        resource: "payment:742",
        arguments: reordered,
        approvalAssertion: "human",
      },
    });
    assert.equal(sameDigest.json.id, a.json.id);
    for (const change of [
      { amountMinor: 5001 },
      { currency: "EUR" },
      { destination: "store_credit" },
      { paymentId: "pi_2" },
    ]) {
      const c = await w.register(d.id, {
        key: "k:digest:1",
        args: { ...args, ...change },
      });
      assert.equal(c.json.code, "operation_conflict", JSON.stringify(change));
    }
  });
  test("floating point and non-integer money are rejected; amounts are integer minor units", async () => {
    const d = (await w.delegate()).json;
    const r = await w.register(d.id, {
      key: "k:float:1",
      args: { amountMinor: 150.5, currency: "USD" },
    });
    assert.equal(r.json.code, "invalid_request");
  });
  test("tenant guard raises the approval requirement; the customer assertion can never lower it", async () => {
    const d = (await w.delegate()).json;
    const auto = await w.register(d.id, {
      key: "k:req:50:none",
      amountMinor: 5000,
      assertion: "none",
    });
    assert.equal(auto.json.approvalRequirement, "none");
    const manager = await w.register(d.id, {
      key: "k:req:150:human",
      amountMinor: 15000,
      assertion: "human",
    });
    assert.equal(manager.json.approvalRequirement, "human");
    const forged = await w.register(d.id, {
      key: "k:req:150:none",
      amountMinor: 15000,
      assertion: "none",
    });
    assert.equal(forged.json.approvalRequirement, "human");
    const audit = await w.audit(forged.json.id);
    assert.equal(
      (
        await w.store.pool.query(
          "select evaluation from authority.audit_events where operation_id=$1 and type='operation.registered'",
          [forged.json.id],
        )
      ).rows[0].evaluation.requirementRaisedByTenantGuard,
      true,
    );
    assert.ok(audit.some((e) => e.type === "operation.registered"));
  });
  test("delegation bounds: action, resource prefix and numeric ceiling", async () => {
    const d = (
      await w.delegate({
        ceilings: { amountMinor: 20000 },
        resourcePrefixes: ["payment:"],
      })
    ).json;
    assert.equal(
      (await w.register(d.id, { key: "k:b:1", amountMinor: 20001 })).json
        .details.reason,
      "delegation_ceiling_exceeded",
    );
    assert.equal(
      (await w.register(d.id, { key: "k:b:2", resource: "invoice:9" })).json
        .details.reason,
      "resource_outside_delegation",
    );
    assert.equal(
      (await w.register(d.id, { key: "k:b:3", action: "deploy:production" }))
        .json.details.reason,
      "action_outside_delegation",
    );
    assert.equal(
      (await w.register(d.id, { key: "k:b:4", amountMinor: 20000 })).status,
      200,
    );
    // A ceiling field sent as a string cannot be compared, so it fails closed.
    const stringAmount = await w.register(d.id, {
      key: "k:b:5",
      args: { amountMinor: "999999", currency: "USD" },
    });
    assert.equal(stringAmount.status, 403);
    assert.equal(
      stringAmount.json.details.reason,
      "delegation_ceiling_exceeded",
    );
  });
  test("a forwarded initiator must be the delegation owner for user-owned grants", async () => {
    const d = (await w.delegate({ person: PEOPLE.alice })).json;
    const r = await w.register(d.id, {
      key: "k:init:1",
      initiator: PEOPLE.morgan,
    });
    assert.equal(r.json.details.reason, "subject_is_not_delegation_owner");
  });
  test("operations cannot be registered against revoked or expired delegations", async () => {
    const d = (await w.delegate({ ttlMs: 3600_000 })).json;
    const revoked = (await w.delegate()).json;
    await w.call("POST", `/v1/delegations/${revoked.id}/revoke`, {
      token: await w.tok.api(),
      body: {},
    });
    assert.equal(
      (await w.register(revoked.id, { key: "k:rv:1" })).json.code,
      "delegation_revoked",
    );
    w.clock.advance(2 * 3600_000);
    assert.equal(
      (await w.register(d.id, { key: "k:ex:1" })).json.code,
      "delegation_expired",
    );
    w.clock.advance(-2 * 3600_000);
  });
});
