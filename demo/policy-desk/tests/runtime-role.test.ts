import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { cleanupExpired } from "../src/cleanup.js";
import { openHost } from "../src/host.js";
import { runtimeGrants } from "../tools/migrate.js";
import { startWorld, ORIGIN, type World } from "./helpers/world.js";

let w: World;
let runtimeUrl: string;
before(async () => {
  w = await startWorld();
  // The Worker migrates on first request (as the owner, as in the test world).
  assert.equal((await w.raw("/healthz")).status, 200);
  const owner = w.pool();
  try {
    // Roles are cluster-wide; other test databases may have created it already.
    await owner.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'policy_desk_runtime') then
        create role policy_desk_runtime login password 'runtime-local-only';
      end if; end $$`);
    await owner.query(runtimeGrants());
  } finally {
    await owner.end();
  }
  const u = new URL(w.env.DATABASE_URL!);
  u.username = "policy_desk_runtime";
  u.password = "runtime-local-only";
  runtimeUrl = u.toString();
});
after(async () => w.close());

async function asRuntime<T>(fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: runtimeUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function expiredSandboxTenant(user: string) {
  const t = await w.login(user);
  const created = await w.raw("/sandbox/reset", {
    method: "POST",
    token: t,
    body: "{}",
    headers: { "cf-connecting-ip": "192.0.2.91" },
  });
  assert.equal(created.status, 200);
  const sid = ((await (await w.raw("/sandbox/me", { token: t })).json()) as any)
    .sandboxId as string;
  const owner = w.pool();
  try {
    await owner.query(
      "update policy_desk.sandboxes set expires_at = now() - interval '1 minute' where id=$1",
      [sid],
    );
  } finally {
    await owner.end();
  }
  return `pd_${sid.slice(4)}_g1`;
}

describe("least-privilege runtime role", () => {
  it("serves the sandbox and refund flow with only the runtime role's grants", async () => {
    const saved = { ...w.env };
    Object.assign(w.env, {
      DATABASE_URL: runtimeUrl,
      MIGRATE_ON_REQUEST: "false",
    });
    try {
      const agent = (
        (await (
          await fetch(`${w.oidc.issuer}oauth/token`, {
            method: "POST",
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: "agent",
              client_secret: "agt-s",
              audience: w.env.TASK_AUTHORITY_AUDIENCE!,
            }),
          })
        ).json()) as any
      ).access_token as string;
      const t = await w.login("alice");
      assert.equal((await w.call("POST", "/sandbox/reset", t, {})).status, 200);
      const sandboxId = (await w.call("GET", "/sandbox/me", t)).json.sandboxId;
      const orderId = (await w.call("GET", "/sandbox/orders", t)).json.orders[0]
        .orderId as string;
      const r = await w.call(
        "POST",
        "/v1/refunds",
        agent,
        { orderId, amountMinor: 2000 },
        { "x-policy-desk-sandbox": sandboxId },
      );
      assert.ok([201, 202].includes(r.status), JSON.stringify(r.json));
      assert.equal((await w.raw("/healthz")).status, 200);
      // Usage tracking for /admin writes with the runtime role's grants too.
      const owner = w.pool();
      try {
        const ev = await owner.query(
          "select kind from policy_desk.usage_events where sandbox_id=$1",
          [sandboxId],
        );
        assert.deepEqual(
          ev.rows.map((x) => x.kind),
          ["sandbox_created"],
        );
        const vis = await owner.query(
          "select count(*)::int n from policy_desk.visitors where sandbox_id=$1",
          [sandboxId],
        );
        assert.equal(vis.rows[0].n, 1);
      } finally {
        await owner.end();
      }
    } finally {
      Object.assign(w.env, saved);
      delete (w.env as { MIGRATE_ON_REQUEST?: string }).MIGRATE_ON_REQUEST;
    }
  });

  it("cannot lift the append-only triggers or rewrite audit history", async () => {
    await asRuntime(async (c) => {
      await assert.rejects(
        c.query(
          "alter table authority.audit_events disable trigger audit_no_update",
        ),
        /must be owner/,
      );
      await assert.rejects(
        c.query(
          "alter table authority.policy_versions disable trigger policy_versions_immutable",
        ),
        /must be owner/,
      );
    });
  });

  it("wipe_tenants refuses anything that is not a sandbox tenant", async () => {
    await asRuntime(async (c) => {
      await assert.rejects(
        c.query("select policy_desk.wipe_tenants(array['acme'])"),
        /refuses tenant id acme/,
      );
      await assert.rejects(
        c.query(
          "select policy_desk.wipe_tenants(array['pd_000000000000000000000000_g1', 'other'])",
        ),
        /refuses tenant id other/,
      );
    });
  });

  it("TTL cleanup still works as the runtime role and leaves the triggers enabled", async () => {
    const tenant = await expiredSandboxTenant("carol");
    const owner = w.pool();
    try {
      const before = await owner.query(
        "select count(*)::int n from authority.audit_events where tenant_id=$1",
        [tenant],
      );
      assert.ok(before.rows[0].n > 0, "the sandbox wrote audit rows");
      await owner.query(
        'insert into policy_desk.agent_conversations (tenant_id, sandbox_id, turns, updated_at) values ($1, \'sbx_x\', \'[{"role":"user","text":"hi"}]\', now())',
        [tenant],
      );
      await asRuntime(async (c) => {
        await assert.rejects(
          c.query("delete from authority.audit_events where tenant_id=$1", [
            tenant,
          ]),
          /append-only/i,
        );
      });
      const host = await openHost(
        { ...w.env, DATABASE_URL: runtimeUrl, MIGRATE_ON_REQUEST: "false" },
        new Request(ORIGIN),
      );
      try {
        const out = await cleanupExpired(host);
        assert.ok(out.sandboxes >= 1 && out.tenantsWiped >= 1);
      } finally {
        await host.conn.close();
      }
      const left = await owner.query(
        "select count(*)::int n from authority.audit_events where tenant_id=$1",
        [tenant],
      );
      assert.equal(left.rows[0].n, 0);
      const chats = await owner.query(
        "select count(*)::int n from policy_desk.agent_conversations where tenant_id=$1",
        [tenant],
      );
      assert.equal(chats.rows[0].n, 0, "the agent conversation goes too");
      const archived = await owner.query(
        "select operations, policy_versions from policy_desk.tenant_usage where tenant_id=$1",
        [tenant],
      );
      assert.equal(archived.rows.length, 1, "totals archived before the wipe");
      assert.ok(archived.rows[0].policy_versions > 0);
      const trg = await owner.query(
        "select tgenabled from pg_trigger where tgname in ('audit_no_update','policy_versions_immutable')",
      );
      assert.ok(
        trg.rows.length === 2 && trg.rows.every((r) => r.tgenabled === "O"),
      );
    } finally {
      await owner.end();
    }
  });
});
