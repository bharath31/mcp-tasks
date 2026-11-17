import type { SqlDatabase } from "../sql.js";
import { initSimulatedWalletSchema } from "./schema.js";

/**
 * Trusted host-only simulated funding. Never exposed on DO fetch RPC or public routes.
 * Wallet balance is not customer approval — the host must still verify quotes/consent before place.
 */
export function provisionSimulatedWalletFunds(
  db: SqlDatabase,
  customerId: string,
  amountMinor: number,
): void {
  if (typeof customerId !== "string" || customerId.length === 0) {
    throw new Error("sim_wallet_customer_required");
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error("sim_wallet_provision_invalid");
  }
  initSimulatedWalletSchema(db);
  db.transaction(() => {
    const existing = db
      .exec(
        "SELECT balance_minor FROM sim_wallet_balances WHERE customer_id = ?",
        customerId,
      )
      .one();
    if (!existing) {
      db.exec(
        "INSERT INTO sim_wallet_balances VALUES (?, ?)",
        customerId,
        amountMinor,
      );
      return;
    }
    const next = (existing.balance_minor as number) + amountMinor;
    if (!Number.isSafeInteger(next)) {
      throw new Error("sim_wallet_balance_overflow");
    }
    db.exec(
      "UPDATE sim_wallet_balances SET balance_minor = ? WHERE customer_id = ?",
      next,
      customerId,
    );
  });
}

export function readSimulatedWalletBalanceMinor(
  db: SqlDatabase,
  customerId: string,
): number {
  initSimulatedWalletSchema(db);
  const row = db
    .exec(
      "SELECT balance_minor FROM sim_wallet_balances WHERE customer_id = ?",
      customerId,
    )
    .one();
  return row ? (row.balance_minor as number) : 0;
}
