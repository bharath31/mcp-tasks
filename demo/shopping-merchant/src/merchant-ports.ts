import { createMerchantDemoAccountPort } from "./customer-account/demo-address.js";
import { createFencedSimulatedWalletLedgerSlice } from "./simulated-wallet/fenced-ledger-adapter.js";
import type { MerchantLedgerEnv } from "./port-env.js";
import type { SqlDatabase } from "./sql.js";
import type {
  CustomerApprovalVerifier,
  MerchantLedgerPorts,
} from "./types.js";

/** Production customer approval is CIBA-backed; non-CIBA inject stays fail-closed. */
const failClosedCustomerApproval: CustomerApprovalVerifier = async () => false;

/**
 * Restart-durable merchant ports for one customer DO SQLite database.
 * Call only inside the Durable Object after trusted customer binding.
 */
export function createMerchantLedgerPorts(
  db: SqlDatabase,
  customerId: string,
  env: MerchantLedgerEnv,
): MerchantLedgerPorts {
  const wallet = createFencedSimulatedWalletLedgerSlice(db, customerId);
  return {
    customerAccount: createMerchantDemoAccountPort(db, customerId),
    verifyCustomerApproval: failClosedCustomerApproval,
    orderProvider: wallet.orderProvider,
    atomicAbandonAbsent: wallet.atomicAbandonAbsent,
  };
}

export function merchantDisplayNameFromEnv(env: MerchantLedgerEnv): string {
  const name = env.SHOPPING_MERCHANT_DISPLAY_NAME?.trim();
  return name && name.length > 0 ? name : "Stillroom";
}