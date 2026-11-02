import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { MIGRATIONS_DIR, Store } from "../../service/src/store.js";
import { createTestDb } from "../helpers/pg.js";

test("0005 backfills pre-policy operations from their approval requirement instead of denying them", async () => {
  const db = await createTestDb("mig");
  const store = new Store(db.url, 4);
  try {
    await store.pool.query(
      "create table if not exists public.task_authority_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    for (const name of [
      "0001_init.sql",
      "0002_harden_roles.sql",
      "0003_pin_function_search_path.sql",
      "0004_ciba.sql",
    ]) {
      await store.pool.query(await readFile(MIGRATIONS_DIR + name, "utf8"));
      await store.pool.query(
        "insert into public.task_authority_migrations(name) values($1)",
        [name],
      );
    }
    const at = new Date("2026-01-01T00:00:00Z");
    await store.pool.query(
      "insert into authority.delegations(id,tenant_id,organization_id,owner_type,actor_id,agent_id,resource,actions,provenance,policy_ref,correlation_id,created_at,expires_at) values('dlg_1','t','o','user','a','ag','merchant:o/refunds','{refund:create}','{}','p','c',$1,$2)",
      [at, new Date("2027-01-01T00:00:00Z")],
    );
    for (const [id, requirement, status] of [
      ["op_pending", "human", "registered"],
      ["op_plain", "none", "registered"],
      ["op_settled", "none", "settled"],
    ] as const)
      await store.pool.query(
        "insert into authority.operations(id,tenant_id,organization_id,delegation_id,operation_key,action,resource,scope,arguments,canonical_version,canonical,digest,approval_assertion,approval_requirement,correlation_id,status,created_at,expires_at) values($1,'t','o','dlg_1',$1,'refund:create','payment:1','merchant:o/refunds','{}',1,'{}','sha256:x','none',$2,'c',$3,$4,$5)",
        [id, requirement, status, at, new Date("2027-01-01T00:00:00Z")],
      );
    await store.migrate();
    const rows = await store.pool.query(
      "select id,decision,reason_code,resource_server,policy_details from authority.operations order by id",
    );
    const by = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
    assert.equal(by.op_pending.decision, "approval_required");
    assert.equal(by.op_pending.reason_code, "pre_policy_approval_required");
    assert.equal(by.op_pending.policy_details.decision, "approval_required");
    assert.equal(by.op_plain.decision, "allow");
    assert.equal(by.op_plain.reason_code, "pre_policy_allowed");
    assert.equal(by.op_settled.decision, "allow");
    assert.equal(by.op_plain.resource_server, "merchant:o/refunds");
    assert.deepEqual(by.op_plain.policy_details.budgetRuleIds, []);
  } finally {
    await store.close();
    await db.drop();
  }
});
