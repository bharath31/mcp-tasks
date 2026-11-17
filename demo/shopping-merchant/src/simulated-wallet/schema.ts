import type { SqlDatabase } from "../sql.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sim_wallet_balances (
  customer_id TEXT PRIMARY KEY NOT NULL,
  balance_minor INTEGER NOT NULL CHECK (balance_minor >= 0)
);
CREATE TABLE IF NOT EXISTS sim_wallet_orders (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  terms_fingerprint TEXT NOT NULL,
  UNIQUE (customer_id, operation_id)
);
`;

export function initSimulatedWalletSchema(db: SqlDatabase): void {
  for (const statement of SCHEMA.split(";\n").filter((s) => s.trim())) {
    db.exec(statement);
  }
}
