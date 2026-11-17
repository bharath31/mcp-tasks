import type { SqlDatabase } from "../sql.js";

const ADDRESS_SCHEMA = `CREATE TABLE IF NOT EXISTS merchant_demo_addresses (
  customer_id TEXT NOT NULL,
  address_id TEXT NOT NULL,
  label TEXT NOT NULL,
  version TEXT NOT NULL,
  trusted_for_agent_checkout INTEGER NOT NULL,
  destination_json TEXT NOT NULL,
  PRIMARY KEY (customer_id, address_id)
)`;

export function initMerchantDemoAddressSchema(db: SqlDatabase): void {
  db.exec(ADDRESS_SCHEMA);
}