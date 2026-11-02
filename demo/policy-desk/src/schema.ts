// Idempotent schema bootstrap, guarded for cold starts: one in-flight promise
// per isolate plus a Postgres advisory lock across isolates. Uses the same
// bookkeeping table and lock id as the service's Store.migrate().
import pg from "pg";

export type Migration = { name: string; sql: string };
let ready: Promise<void> | null = null;
let readyFor = "";

export function ensureSchema(
  client: pg.Client,
  migrations: Migration[],
  key = "default",
): Promise<void> {
  if (ready && readyFor === key) return ready;
  readyFor = key;
  ready = run(client, migrations).catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}
export const resetSchemaGuard = () => {
  ready = null;
};

export async function run(client: pg.Client, migrations: Migration[]) {
  await client.query("select pg_advisory_lock(7447002)");
  try {
    await client.query(
      "create table if not exists public.task_authority_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    for (const m of migrations) {
      const done = await client.query(
        "select 1 from public.task_authority_migrations where name = $1",
        [m.name],
      );
      if (done.rowCount) continue;
      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query(
          "insert into public.task_authority_migrations (name) values ($1)",
          [m.name],
        );
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw e;
      }
    }
  } finally {
    await client
      .query("select pg_advisory_unlock(7447002)")
      .catch(() => undefined);
  }
}
