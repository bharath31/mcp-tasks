import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ServiceError } from "./errors.js";

export type Db = {
  query<R extends pg.QueryResultRow = any>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
};

export type DelegationRow = {
  id: string;
  tenant_id: string;
  organization_id: string;
  owner_type: "user" | "organization";
  actor_id: string;
  agent_id: string;
  resource: string;
  actions: string[];
  resource_prefixes: string[] | null;
  ceilings: Record<string, number>;
  provenance: Record<string, unknown>;
  policy_ref: string;
  correlation_id: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
};
export type OperationRow = {
  id: string;
  tenant_id: string;
  organization_id: string;
  delegation_id: string | null;
  facts: Record<string, import("@task-authority/contracts").Json>;
  actor: import("./policies.js").PolicyActor;
  policy_version: string | null;
  rule_ids: string[];
  decision: import("./policies.js").PolicyDecision["decision"];
  reason_code: string;
  policy_details: import("./policies.js").PolicyDecision;
  operation_key: string;
  task_id: string | null;
  action: string;
  resource: string;
  scope: string;
  resource_server: string;
  arguments: Record<string, any>;
  canonical_version: number;
  digest: string;
  business_state_version: string | null;
  approval_assertion: "none" | "human";
  approval_requirement: "none" | "human";
  initiator_id: string | null;
  correlation_id: string;
  status: "registered" | "claimed" | "settled" | "cancelled" | "rejected";
  created_at: Date;
  expires_at: Date;
};
export type ApprovalRow = {
  id: string;
  tenant_id: string;
  organization_id: string;
  operation_id: string;
  operation_digest: string;
  permission: string;
  reviewer_hint: string | null;
  lease_reviewer_id: string | null;
  lease_expires_at: Date | null;
  status: "pending" | "approved" | "rejected" | "expired";
  approver_id: string | null;
  assurance: Record<string, unknown> | null;
  method: "portal_stepup" | "ciba_rar";
  correlation_id: string;
  ciba_auth_req_id: string | null;
  reviewer_subject: string | null;
  requested_at: Date;
  decided_at: Date | null;
  expires_at: Date;
};
export type ClaimRow = {
  id: string;
  tenant_id: string;
  organization_id: string;
  operation_id: string;
  delegation_id: string | null;
  approval_id: string | null;
  seq: number;
  status:
    "claimed" | "pending" | "unknown" | "succeeded" | "failed" | "released";
  execution_key: string;
  claimed_by: string;
  effective_authority: Record<string, unknown>;
  correlation_id: string;
  minted_at: Date;
  lease_expires_at: Date;
  outcome: Record<string, unknown> | null;
};

export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

export class Store {
  readonly pool: pg.Pool;
  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({
      connectionString,
      max,
      connectionTimeoutMillis: 5000,
      application_name: "task-authority",
    });
  }
  /**
   * One transaction per request. ServiceErrors COMMIT: handlers only throw them
   * before mutating state, or after appending denial audit rows that must persist.
   * Anything else rolls back.
   */
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout = '8s'");
      await client.query("set local statement_timeout = '20s'");
      try {
        const out = await fn(client);
        await client.query("commit");
        return out;
      } catch (error) {
        if (error instanceof ServiceError) {
          await client.query("commit");
        } else {
          await client.query("rollback").catch(() => undefined);
        }
        throw error;
      }
    } finally {
      client.release();
    }
  }
  async ping() {
    await this.pool.query("select 1");
  }
  async migrate() {
    await this.pool.query(
      "create table if not exists public.task_authority_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const name of files) {
      const client = await this.pool.connect();
      try {
        await client.query("select pg_advisory_lock(7447002)");
        const done = await client.query(
          "select 1 from public.task_authority_migrations where name = $1",
          [name],
        );
        if (done.rowCount) continue;
        await client.query("begin");
        await client.query(await readFile(MIGRATIONS_DIR + name, "utf8"));
        await client.query(
          "insert into public.task_authority_migrations (name) values ($1)",
          [name],
        );
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        await client
          .query("select pg_advisory_unlock(7447002)")
          .catch(() => undefined);
        client.release();
      }
    }
  }
  async close() {
    await this.pool.end();
  }
}

export const iso = (d: Date | number) => new Date(d).toISOString();
