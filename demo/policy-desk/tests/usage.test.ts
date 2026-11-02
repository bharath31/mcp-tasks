import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { openHost } from "../src/host.js";
import { recordModelCall } from "../src/usage.js";
import { wipeTenants } from "../src/cleanup.js";
import { startWorld, ORIGIN, type World } from "./helpers/world.js";

let w: World;
let alice: string;
let carol: string;
before(async () => {
  w = await startWorld();
  w.env.ADMIN_EMAILS = "Carol@example.test";
  w.env.ADMIN_SUBS = "auth0|bob";
  alice = await w.login("alice");
  carol = await w.login("carol");
});
after(async () => w.close());

const withId = (token: string, idOf = token) => ({
  "x-id-token": w.idTokenFor(idOf)!,
});
const usage = (token: string, headers: Record<string, string> = {}) =>
  w.call("GET", "/sandbox/admin/usage", token, undefined, headers);
const userRow = (u: any, email: string) =>
  u.users.find((r: any) => r.email === email);

describe("admin usage page data", () => {
  it("records the visitor's verified email from their ID token", async () => {
    const me = await w.call(
      "GET",
      "/sandbox/me",
      alice,
      undefined,
      withId(alice),
    );
    assert.equal(me.status, 200);
    const r = await w.call("POST", "/sandbox/reset", alice, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    for (const id of ["small_within_budget", "routine_approval"])
      assert.equal(
        (await w.call("POST", "/sandbox/scenario", alice, { id })).status,
        200,
      );
    const u = (await usage(carol, withId(carol))).json;
    const a = userRow(u, "alice@example.test");
    assert.ok(a, JSON.stringify(u.users));
    assert.equal(a.emailVerified, true);
    assert.equal(a.name, "Alice");
    assert.equal(a.sandboxesCreated, 1);
    assert.equal(a.scenarioRuns, 2);
    assert.equal(a.sandbox.active, true);
    assert.ok(a.operations >= 2);
    assert.ok(a.approvalsRequested >= 1);
    assert.ok(a.refundsExecuted >= 1);
    assert.equal(u.totals.scenarioRuns, 2);
    assert.equal(u.totals.modelCalls, 0);
    assert.equal(u.modelTracking, false);
    assert.equal(u.daily.length, 14);
    assert.ok(u.recent.some((e: any) => e.kind === "scenario_run"));
  });

  it("is refused to everyone but the configured operators", async () => {
    const notAdmin = await usage(alice, withId(alice));
    assert.equal(notAdmin.status, 403);
    assert.equal(notAdmin.json.reason, "admin_only");
    // The allowlisted email only counts from a verified ID token for the same subject.
    assert.equal((await usage(carol)).status, 403);
    assert.equal((await usage(alice, withId(alice, carol))).status, 403);
    assert.equal((await usage(carol, withId(carol, alice))).status, 403);
    assert.equal((await usage(carol, { "x-id-token": "a.b.c" })).status, 403);
    assert.equal((await usage("a.b.c")).status, 401);
    // ADMIN_SUBS needs no ID token.
    const bob = await w.login("bob");
    assert.equal((await usage(bob)).status, 200);
    const savedSubs = w.env.ADMIN_SUBS;
    w.env.ADMIN_SUBS = "auth0|BOB";
    try {
      assert.equal((await usage(bob)).status, 403);
    } finally {
      w.env.ADMIN_SUBS = savedSubs;
    }
    const saved = w.env.ADMIN_EMAILS;
    w.env.ADMIN_EMAILS = undefined;
    try {
      assert.equal((await usage(carol, withId(carol))).status, 403);
    } finally {
      w.env.ADMIN_EMAILS = saved;
    }
  });

  it("counts model calls and tokens through the agent hook", async () => {
    const sid = (await w.call("GET", "/sandbox/me", alice)).json.sandboxId;
    const host = await openHost(w.env, new Request(ORIGIN));
    try {
      await recordModelCall(host, sid, {
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        inputTokens: 1200,
        outputTokens: 300,
        durationMs: 900,
      });
    } finally {
      await host.conn.close();
    }
    const u = (await usage(carol, withId(carol))).json;
    assert.equal(u.modelTracking, true);
    assert.equal(u.totals.modelCalls, 1);
    assert.equal(u.totals.inputTokens, 1200);
    assert.equal(u.totals.outputTokens, 300);
    assert.equal(userRow(u, "alice@example.test").modelCalls, 1);
    assert.equal(u.daily.at(-1).tokens, 1500);
  });

  it("keeps usage history after TTL cleanup wipes the sandbox", async () => {
    const before = (await usage(carol, withId(carol))).json;
    const a0 = userRow(before, "alice@example.test");
    const sid = a0.sandboxId;
    const pool = w.pool();
    try {
      await pool.query(
        "update policy_desk.sandboxes set expires_at = now() - interval '1 minute' where id=$1",
        [sid],
      );
    } finally {
      await pool.end();
    }
    const out = await w.app.scheduled(w.env);
    assert.equal(out.sandboxes, 1);
    const pool2 = w.pool();
    try {
      const left = await pool2.query(
        "select count(*)::int n from authority.operations where tenant_id like $1",
        [`pd_${sid.slice(4)}_%`],
      );
      assert.equal(left.rows[0].n, 0);
    } finally {
      await pool2.end();
    }
    const after = (await usage(carol, withId(carol))).json;
    const a1 = userRow(after, "alice@example.test");
    assert.equal(a1.sandbox, null);
    for (const k of [
      "operations",
      "approvalsRequested",
      "refundsExecuted",
      "policyVersions",
      "scenarioRuns",
      "modelCalls",
    ])
      assert.equal(a1[k], a0[k], k);
    assert.equal(after.totals.operations, before.totals.operations);
    assert.equal(
      after.totals.activeSandboxes,
      before.totals.activeSandboxes - 1,
    );
    // A second cleanup pass archives nothing twice.
    await w.app.scheduled(w.env);
    const again = userRow(
      (await usage(carol, withId(carol))).json,
      "alice@example.test",
    );
    assert.equal(again.operations, a0.operations);
  });

  it("archives each tenant once when cleanup jobs overlap", async () => {
    const bob = await w.login("bob");
    const reset = await w.call("POST", "/sandbox/reset", bob, {});
    assert.equal(reset.status, 200);
    assert.equal(
      (
        await w.call("POST", "/sandbox/scenario", bob, {
          id: "small_within_budget",
        })
      ).status,
      200,
    );
    const sid = reset.json.sandboxId;
    const tenant = `pd_${sid.slice(4)}_g${reset.json.generation}`;
    const before = (await usage(carol, withId(carol))).json.users.find(
      (u: any) => u.sandboxId === sid,
    );
    const hosts = await Promise.all([
      openHost(w.env, new Request(ORIGIN)),
      openHost(w.env, new Request(ORIGIN)),
    ]);
    try {
      await Promise.all(
        hosts.map((host) => wipeTenants(host, [tenant, tenant])),
      );
    } finally {
      await Promise.all(hosts.map((host) => host.conn.close()));
    }
    const after = (await usage(carol, withId(carol))).json.users.find(
      (u: any) => u.sandboxId === sid,
    );
    assert.ok(before.operations > 0);
    for (const k of ["operations", "refundsExecuted", "policyVersions"])
      assert.equal(after[k], before[k], k);
    const pool = w.pool();
    try {
      const archive = await pool.query(
        "select count(*)::int n from policy_desk.tenant_usage where tenant_id=$1",
        [tenant],
      );
      assert.equal(archive.rows[0].n, 1);
    } finally {
      await pool.end();
    }
  });

  it("deletes approval-ledger rows only for tenants included in the wipe", async () => {
    const suffixA = randomUUID().replaceAll("-", "").slice(0, 24);
    let suffixB = randomUUID().replaceAll("-", "").slice(0, 24);
    while (suffixB === suffixA)
      suffixB = randomUUID().replaceAll("-", "").slice(0, 24);
    const tenantA = `pd_${suffixA}_g1`;
    const tenantB = `pd_${suffixB}_g1`;
    const idA = `apr_${randomUUID().replaceAll("-", "")}`;
    const idB = `apr_${randomUUID().replaceAll("-", "")}`;
    const pool = w.pool();
    const host = await openHost(w.env, new Request(ORIGIN));
    try {
      await pool.query(
        `insert into policy_desk.approval_requests
         (id, request, expires_at, tenant_id, sandbox_id, generation)
         values ($1, $2::jsonb, now() + interval '15 minutes', $3, $4, 1),
                ($5, $6::jsonb, now() + interval '15 minutes', $7, $8, 1)`,
        [
          idA,
          JSON.stringify({ id: idA }),
          tenantA,
          `sbx_${suffixA}`,
          idB,
          JSON.stringify({ id: idB }),
          tenantB,
          `sbx_${suffixB}`,
        ],
      );

      await wipeTenants(host, [tenantA]);

      const remaining = await pool.query(
        "select id, tenant_id from policy_desk.approval_requests where id = any($1)",
        [[idA, idB]],
      );
      assert.deepEqual(remaining.rows, [{ id: idB, tenant_id: tenantB }]);
    } finally {
      await host.conn.close();
      await pool.end();
    }
  });
});
