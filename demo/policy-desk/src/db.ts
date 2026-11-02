// Per-request Postgres access. Workers cannot share I/O objects across
// requests, so each request opens one pg Client (through Hyperdrive when
// bound) and closes it at the end. The Store-shaped object below is the
// minimum the service handler needs (pool.query, tx, ping); it copies
// Store.tx's transaction semantics exactly (ServiceErrors COMMIT).
import pg from "pg";
import { ServiceError } from "../../../auth0/service/src/errors.js";
import type { Db, Store } from "../../../auth0/service/src/store.js";
import type { Env } from "./env.js";

/** Round trips this request spent, reported to the browser as Server-Timing. */
export type Timings = {
  connectMs: number;
  queries: number;
  queryMs: number;
  fgaCalls: number;
  fgaMs: number;
  modelCalls: number;
  modelMs: number;
};

export type Conn = {
  client: pg.Client;
  timings: Timings;
  db: Db;
  store: Store;
  close(): Promise<void>;
};

export function connectionString(env: Env) {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error("No HYPERDRIVE binding or DATABASE_URL");
  return url;
}

export async function connect(env: Env): Promise<Conn> {
  const client = new pg.Client({
    connectionString: connectionString(env),
    application_name: "policy-desk",
    connectionTimeoutMillis: 8000,
  });
  const t0 = Date.now();
  await client.connect();
  const timings: Timings = {
    connectMs: Date.now() - t0,
    queries: 0,
    queryMs: 0,
    fgaCalls: 0,
    fgaMs: 0,
    modelCalls: 0,
    modelMs: 0,
  };
  // One connection serves the whole request, and the service issues some
  // queries concurrently; serialise them explicitly instead of relying on pg's queue.
  let chain: Promise<unknown> = Promise.resolve();
  const q = (sql: string, params?: unknown[]) => {
    const run = chain.then(async () => {
      const t = Date.now();
      try {
        return await client.query(sql, params as any[]);
      } finally {
        timings.queries++;
        timings.queryMs += Date.now() - t;
      }
    });
    chain = run.catch(() => undefined);
    return run;
  };
  const db: Db = { query: q as Db["query"] };
  const store = {
    pool: db,
    ping: async () => void (await q("select 1")),
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      // One round trip: a parameterless query runs all three statements in one simple-protocol message.
      await q(
        "begin; set local lock_timeout = '8s'; set local statement_timeout = '20s'",
      );
      try {
        const out = await fn(db);
        await q("commit");
        return out;
      } catch (error) {
        if (error instanceof ServiceError) await q("commit");
        else await q("rollback").catch(() => undefined);
        throw error;
      }
    },
  } as unknown as Store;
  return {
    client,
    timings,
    db,
    store,
    close: () => client.end().catch(() => undefined),
  };
}
