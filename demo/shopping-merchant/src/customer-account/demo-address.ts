import type { SqlDatabase } from "../sql.js";
import type { TrustedDestination } from "../types.js";
import type { MerchantLedgerEnv } from "../port-env.js";
import { initMerchantDemoAddressSchema } from "./schema.js";

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** Merchant-owned demo ship-to seeded once per customer DO; destination is not client-supplied. */
export function ensureMerchantDemoShippingAddress(
  db: SqlDatabase,
  customerId: string,
  env: MerchantLedgerEnv,
): void {
  const addressId = env.SHOPPING_MERCHANT_SHIPPING_ADDRESS_ID?.trim();
  if (!nonempty(addressId)) throw new Error("shipping_unconfigured");
  initMerchantDemoAddressSchema(db);
  const exists = db
    .exec(
      "SELECT 1 AS ok FROM merchant_demo_addresses WHERE customer_id = ? AND address_id = ?",
      customerId,
      addressId,
    )
    .one();
  if (exists) return;
  const label =
    env.SHOPPING_MERCHANT_SHIPPING_LABEL?.trim() ?? "Stillroom shipping";
  const destination = {
    country: "US",
    postalCode: "10001",
    locality: "New York",
    line1: "Merchant fulfillment (demo)",
  };
  db.exec(
    `INSERT INTO merchant_demo_addresses
     (customer_id, address_id, label, version, trusted_for_agent_checkout, destination_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    customerId,
    addressId,
    label,
    "1",
    1,
    JSON.stringify(destination),
  );
}

export function createMerchantDemoAccountPort(
  db: SqlDatabase,
  customerId: string,
): {
  getAddress(
    customerIdParam: string,
    addressId: string,
  ): Promise<TrustedDestination | null>;
} {
  return {
    async getAddress(customerIdParam, addressId) {
      if (customerIdParam !== customerId) return null;
      initMerchantDemoAddressSchema(db);
      const row = db
        .exec(
          `SELECT address_id, label, version, trusted_for_agent_checkout, destination_json
           FROM merchant_demo_addresses
           WHERE customer_id = ? AND address_id = ?`,
          customerId,
          addressId,
        )
        .one();
      if (!row) return null;
      let destination: Record<string, unknown>;
      try {
        destination = JSON.parse(String(row.destination_json)) as Record<
          string,
          unknown
        >;
      } catch {
        return null;
      }
      return {
        id: String(row.address_id),
        customerId,
        label: String(row.label),
        version: String(row.version),
        trustedForAgentCheckout: Number(row.trusted_for_agent_checkout) === 1,
        destination,
      };
    },
  };
}