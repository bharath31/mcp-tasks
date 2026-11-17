import type { MerchantLedgerPorts } from "./types.js";

/** Wrangler-bindable env keys for port wiring inside each DO isolate (not Worker fetch). */
export type MerchantLedgerEnv = {
  /**
   * Shared secret for Worker→DO internal RPC (transport gate only; not customer approval proof).
   * Must be set via Wrangler secret / env binding before any DO ledger operation is enabled.
   */
  MERCHANT_HOST_INTERNAL_SECRET?: string;
  LEDGER?: DurableObjectNamespace;
  [key: string]: unknown;
};

export const MERCHANT_HOST_INTERNAL_SECRET_HEADER = "x-nominee-host-internal-secret";

/**
 * Build ledger ports from Worker env inside the Durable Object isolate.
 * Production wiring (Task Authority, account service, payment provider) is not implemented in this slice.
 */
export function merchantLedgerPortsFromEnv(_env: MerchantLedgerEnv): MerchantLedgerPorts {
  throw new Error("merchant_ports_unconfigured");
}

export function readHostInternalSecret(env: MerchantLedgerEnv): string | undefined {
  const value = env.MERCHANT_HOST_INTERNAL_SECRET;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}