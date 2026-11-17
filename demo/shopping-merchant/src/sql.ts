/** Minimal SQL surface used by the merchant ledger (DO SqlStorage or test double). */
export type SqlRow = Record<string, unknown>;

export type SqlCursor = {
  one(): SqlRow | null;
  all(): SqlRow[];
};

export type SqlDatabase = {
  exec(query: string, ...bindings: unknown[]): SqlCursor;
  transaction<T>(fn: () => T): T;
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS carts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  agent_id TEXT,
  pairwise_user_id TEXT,
  session_id TEXT,
  version INTEGER NOT NULL,
  items TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkout_operations (
  cart_id TEXT PRIMARY KEY REFERENCES carts(id),
  operation_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id),
  operation_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(operation_id, revision)
);
CREATE TABLE IF NOT EXISTS quote_customer_approvals (
  quote_id TEXT PRIMARY KEY REFERENCES quotes(id),
  operation_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  customer_id TEXT NOT NULL,
  approved_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkout_executions (
  operation_id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_key TEXT NOT NULL UNIQUE,
  order_data TEXT
);`;

export function initMerchantSchema(db: SqlDatabase): void {
  for (const statement of SCHEMA.split(";\n").filter((s) => s.trim())) {
    db.exec(statement);
  }
}

export function createDoSqlDatabase(storage: DurableObjectStorage): SqlDatabase {
  const sql = storage.sql;
  return {
    exec(query: string, ...bindings: unknown[]): SqlCursor {
      const cursor = sql.exec(query, ...bindings);
      return {
        one() {
          try {
            return cursor.one() as SqlRow;
          } catch {
            return null;
          }
        },
        all() {
          return [...cursor] as SqlRow[];
        },
      };
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn);
    },
  };
}

/** Node sqlite stand-in for mocked integration tests (not used in the Worker bundle). */
export function createNodeSqlDatabase(
  db: import("node:sqlite").DatabaseSync,
): SqlDatabase {
  return {
    exec(query: string, ...bindings: unknown[]): SqlCursor {
      const trimmed = query.trim();
      const isMutating =
        /^(INSERT|UPDATE|DELETE|CREATE|PRAGMA)/i.test(trimmed) &&
        !/^SELECT/i.test(trimmed);
      const stmt = db.prepare(query);
      const args = bindings as import("node:sqlite").SQLInputValue[];
      if (isMutating) {
        stmt.run(...args);
        return {
          one: () => null,
          all: () => [],
        };
      }
      return {
        one: () => (stmt.get(...args) as SqlRow | undefined) ?? null,
        all: () => stmt.all(...args) as SqlRow[],
      };
    },
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}