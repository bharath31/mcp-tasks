// TTL cleanup. Task Authority's audit and policy tables are append-only by
// trigger, and the Worker's runtime role does not own them, so it cannot lift
// those triggers itself. policy_desk.wipe_tenants (migration 0003, SECURITY
// DEFINER, owned by the migration role) lifts them inside one statement,
// deletes only rows of pd_<sandbox>_g<n> tenants (it refuses any other id), and
// re-enables them. If anything fails the statement rolls back and the triggers
// stay enabled.
//
// Before the wipe, the same transaction archives each tenant's Task Authority totals
// into policy_desk.tenant_usage (see usage.ts), so the /admin page keeps them.
import type { Host } from "./host.js";
import { archiveTenants } from "./usage.js";

const TENANT = /^pd_[a-f0-9]{24}_g\d+$/;

export async function wipeTenants(host: Host, tenantIds: string[]) {
  const ids = [...new Set(tenantIds.filter((t) => TENANT.test(t)))].sort();
  if (!ids.length) return 0;
  await host.conn.store.tx(async (db) => {
    // The wipe toggles table-wide triggers, so serialize all cleanup jobs before
    // reading totals. This also prevents two jobs archiving the same rows.
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      "policy-desk-wipe",
    ]);
    await archiveTenants(db, ids, host.now());
    await db.query("select policy_desk.wipe_tenants($1::text[])", [ids]);
    await db.query(
      "delete from policy_desk.agent_conversations where tenant_id = any($1)",
      [ids],
    );
    await db.query(
      "delete from policy_desk.approval_requests where tenant_id = any($1)",
      [ids],
    );
  });
  return ids.length;
}

/** Deletes sandboxes older than their TTL and generations superseded by a reset. */
export async function cleanupExpired(host: Host) {
  const { db } = host.conn;
  const now = new Date(host.now()).toISOString();
  const expired = await db.query(
    "select id, generation from policy_desk.sandboxes where expires_at <= $1 limit 200",
    [now],
  );
  const tenants: string[] = [];
  for (const r of expired.rows)
    for (let g = 0; g <= r.generation; g++)
      tenants.push(`pd_${String(r.id).slice(4)}_g${g}`);
  const stale = await db.query(
    "select id, generation from policy_desk.sandboxes where generation > 1 and last_reset_at <= $1::timestamptz - interval '5 minutes' and expires_at > $1 limit 200",
    [now],
  );
  for (const r of stale.rows)
    for (let g = 0; g < r.generation; g++)
      tenants.push(`pd_${String(r.id).slice(4)}_g${g}`);
  const wiped = await wipeTenants(host, tenants);
  if (expired.rows.length) {
    // Re-check expiry: a reset may have revived the sandbox since the select.
    const gone = await db.query(
      "delete from policy_desk.sandboxes where id = any($1) and expires_at <= $2 returning id",
      [expired.rows.map((r) => r.id), now],
    );
    // A deleted sandbox's agent keys die with it, even if the token itself is still valid.
    if (gone.rows.length)
      await db.query(
        "delete from policy_desk.agent_keys where sandbox_id = any($1)",
        [gone.rows.map((r) => r.id)],
      );
  }
  await db.query("delete from policy_desk.agent_keys where expires_at <= $1", [
    now,
  ]);
  await db.query(
    "delete from policy_desk.rate_limits where window_start < $1",
    [Math.floor(host.now() / 1000) - 3 * 86400],
  );
  return { sandboxes: expired.rows.length, tenantsWiped: wiped };
}
