import type { SqlDatabase } from "../sql.js";

const CIBA_CHALLENGE_SCHEMA = `CREATE TABLE IF NOT EXISTS purchase_ciba_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  quote_id TEXT NOT NULL,
  quote_revision INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  quote_expires_at TEXT NOT NULL,
  quote_snapshot TEXT NOT NULL,
  canonical_authorization_details_json TEXT NOT NULL,
  auth_req_id TEXT,
  poll_interval_sec INTEGER NOT NULL,
  next_poll_at_ms INTEGER NOT NULL,
  challenge_expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  decided_at_ms INTEGER,
  consumed_at_ms INTEGER,
  failure_code TEXT,
  poll_claim_slot INTEGER
)`;

export function initCibaChallengeSchema(db: SqlDatabase): void {
  db.exec(CIBA_CHALLENGE_SCHEMA);
}
