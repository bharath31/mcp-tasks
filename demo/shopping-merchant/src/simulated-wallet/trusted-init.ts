import type { SqlDatabase } from "../sql.js";
import { SIMULATED_WALLET_INITIAL_BALANCE_MINOR } from "./constants.js";
import { initSimulatedWalletSchema } from "./schema.js";

/**
 * Trusted first-account wallet funding inside the customer DO only.
 * Inserts the documented initial balance when no row exists; never credits again.
 */
export function initializeTrustedSimulatedWalletOnce(
  db: SqlDatabase,
  customerId: string,
): void {
  if (typeof customerId !== "string" || customerId.length === 0) {
    throw new Error("sim_wallet_customer_required");
  }
  initSimulatedWalletSchema(db);
  db.transaction(() => {
    const existing = db
      .exec(
        "SELECT customer_id FROM sim_wallet_balances WHERE customer_id = ?",
        customerId,
      )
      .one();
    if (existing) return;
    if (
      !Number.isSafeInteger(SIMULATED_WALLET_INITIAL_BALANCE_MINOR) ||
      SIMULATED_WALLET_INITIAL_BALANCE_MINOR <= 0
    ) {
      throw new Error("sim_wallet_provision_invalid");
    }
    db.exec(
      "INSERT INTO sim_wallet_balances (customer_id, balance_minor) VALUES (?, ?)",
      customerId,
      SIMULATED_WALLET_INITIAL_BALANCE_MINOR,
    );
  });
}