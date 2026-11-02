import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CLIENTS, ORG, createWorld, type World } from "../helpers/world.js";
let w: World;
before(async () => {
  w = await createWorld();
});
after(async () => {
  await w?.close();
});

test("provider events require a distinct permission and a trusted backend", async () => {
  const body = {
    organizationId: ORG.northstar,
    providerReference: "re_unclaimed",
    action: "refund:create",
    resource: "payment:742",
  };
  assert.equal(
    (
      await w.call("POST", "/v1/provider-events", {
        token: await w.tok.api(),
        body,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await w.call("POST", "/v1/provider-events", {
        token: await w.idp.service(CLIENTS.rogue, ["provider-events:write"]),
        body,
      })
    ).status,
    403,
  );
});

test("unclaimed refunds emit one bypass event while claimed refunds reconcile", async () => {
  const token = await w.idp.service(CLIENTS.api, ["provider-events:write"]);
  const body = {
    organizationId: ORG.northstar,
    providerReference: "re_bypass",
    action: "refund:create",
    resource: "payment:742",
  };
  const report = () => w.call("POST", "/v1/provider-events", { token, body });
  assert.equal((await report()).json.bypassDetected, true);
  assert.equal((await report()).json.bypassDetected, true);
  const audit = await w.store.pool.query(
    "select * from authority.audit_events where type='bypass.detected' and evaluation->>'providerReference'='re_bypass'",
  );
  assert.equal(audit.rowCount, 1);
  const d = (await w.delegate()).json;
  const op = (await w.register(d.id, { amountMinor: 5000, assertion: "none" }))
    .json;
  const claim = (await w.claim(op)).json;
  await w.outcome(op.id, claim.claimId, "succeeded", "re_legitimate");
  const matched = await w.call("POST", "/v1/provider-events", {
    token,
    body: { ...body, providerReference: "re_legitimate" },
  });
  assert.equal(matched.json.matched, true, JSON.stringify(matched.json));
  assert.equal(matched.json.claimId, claim.claimId);
  assert.equal(matched.json.bypassDetected, false);
  const wrongResource = await w.call("POST", "/v1/provider-events", {
    token,
    body: {
      ...body,
      providerReference: "re_other",
      claimId: claim.claimId,
      resource: "payment:other",
    },
  });
  assert.equal(wrongResource.json.bypassDetected, true);
});

test("reference digest coalesces eligible queue items and persists its rate limit", async () => {
  const { PEOPLE } = await import("../helpers/world.js");
  await w.exception();
  await w.exception();
  const body = {};
  const token = await w.tok.user(PEOPLE.morgan, ORG.northstar);
  const first = await w.call("POST", "/v1/approval-requests/digest", {
    token,
    body,
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.ready, true);
  assert.equal(first.json.count, 2);
  assert.match(first.json.message, /2 awaiting/);
  assert.deepEqual(Object.keys(first.json).sort(), [
    "count",
    "message",
    "oldestMinutes",
    "queueUrl",
    "ready",
  ]);
  const second = await w.call("POST", "/v1/approval-requests/digest", {
    token,
    body,
  });
  assert.equal(second.json.ready, false);
  const ineligible = await w.call("POST", "/v1/approval-requests/digest", {
    token: await w.tok.user(PEOPLE.eve, ORG.northstar),
    body,
  });
  assert.equal(ineligible.json.count, 0);
  w.clock.advance(16 * 60000);
  const next = await w.call("POST", "/v1/approval-requests/digest", {
    token: await w.tok.user(PEOPLE.morgan, ORG.northstar),
    body,
  });
  assert.equal(next.json.ready, true);
});

test("claim metadata cannot cover multiple or differently valued provider refunds", async () => {
  const d = (await w.delegate()).json;
  const op = (await w.register(d.id, { amountMinor: 5000, assertion: "none" }))
    .json;
  const claim = (await w.claim(op)).json;
  const token = await w.idp.service(CLIENTS.api, ["provider-events:write"]);
  const report = (providerReference: string, amountMinor = 5000) =>
    w.call("POST", "/v1/provider-events", {
      token,
      body: {
        organizationId: ORG.northstar,
        providerReference,
        claimId: claim.claimId,
        action: "refund:create",
        resource: "payment:742",
        amountMinor,
        currency: "USD",
      },
    });
  assert.equal(
    (await report("re_wrong_amount", 9000)).json.bypassDetected,
    true,
  );
  const results = await Promise.all([report("re_race1"), report("re_race2")]);
  assert.equal(results.filter((r) => r.json.matched).length, 1);
  assert.equal(results.filter((r) => r.json.bypassDetected).length, 1);
});

test("operation status wire contract renders public states while retaining executor lifecycle", async () => {
  const { op, ap } = await w.exception();
  const get = async () =>
    w.call("GET", `/v1/operations/${op.id}`, { token: await w.tok.api() });
  const pending = await get();
  assert.equal(pending.json.status, "pending_approval");
  assert.equal(pending.json.lifecycleStatus, "registered");
  await w.approve(ap.id, op.digest);
  assert.equal((await get()).json.status, "approved");
  const claim = (await w.claim(op)).json;
  await w.outcome(op.id, claim.claimId, "succeeded", "re_status_contract");
  const completed = await get();
  assert.equal(completed.json.status, "completed");
  assert.equal(completed.json.lifecycleStatus, "settled");
});
