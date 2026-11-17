import {
  createFixtureApprovalVerifier,
  createFixtureCustomerAccount,
  createFixtureOrderProvider,
} from "./fixtures.js";
import type { MerchantLedgerPorts } from "./types.js";

/** Wrangler-bindable env keys for port wiring inside each DO isolate (not Worker fetch). */
export type MerchantLedgerEnv = {
  USE_FIXTURE_MERCHANT_PORTS?: string;
  /** Test-only: fixture verifier always returns true when set to "1". */
  MERCHANT_FIXTURE_AUTO_APPROVE?: string;
  /**
   * Shared secret for Worker→DO host-only RPC (transport gate only; not customer approval proof).
   * Must be set via Wrangler secret / env binding before hostInjectCustomerApproval is enabled.
   */
  MERCHANT_HOST_INTERNAL_SECRET?: string;
  LEDGER?: DurableObjectNamespace;
  [key: string]: unknown;
};

export const MERCHANT_HOST_INTERNAL_SECRET_HEADER = "x-nominee-host-internal-secret";

/**
 * Build ledger ports from Worker env inside the Durable Object isolate.
 * Port implementations are not Wrangler binding values; this factory runs in the DO module.
 */
export function merchantLedgerPortsFromEnv(env: MerchantLedgerEnv): MerchantLedgerPorts {
  if (env.USE_FIXTURE_MERCHANT_PORTS === "1") {
    const verify =
      env.MERCHANT_FIXTURE_AUTO_APPROVE === "1"
        ? async () => true
        : createFixtureApprovalVerifier();
    return {
      customerAccount: createFixtureCustomerAccount(),
      verifyCustomerApproval: verify,
      orderProvider: createFixtureOrderProvider(),
    };
  }
  throw new Error("merchant_ports_unconfigured");
}

export function readHostInternalSecret(env: MerchantLedgerEnv): string | undefined {
  const value = env.MERCHANT_HOST_INTERNAL_SECRET;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}