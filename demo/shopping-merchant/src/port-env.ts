import type { ShoppingCibaEnv } from "./ciba/config.js";
import type { MerchantLedgerPorts } from "./types.js";

/** Wrangler-bindable env keys for port wiring inside each DO isolate (not Worker fetch). */
export type MerchantLedgerEnv = Partial<ShoppingCibaEnv> & {
  /**
   * Shared secret for Worker→DO internal RPC (transport gate only; not customer approval proof).
   * Must be set via Wrangler secret / env binding before any DO ledger operation is enabled.
   */
  MERCHANT_HOST_INTERNAL_SECRET?: string;
  SHOPPING_MERCHANT_SHIPPING_ADDRESS_ID?: string;
  SHOPPING_MERCHANT_SHIPPING_LABEL?: string;
  SHOPPING_MERCHANT_DISPLAY_NAME?: string;
  /** Optional subrequest binding for CIBA HTTPS calls (Fetcher service or fetch function). */
  SUBREQUEST_FETCH?: typeof fetch | { fetch: typeof fetch };
  LEDGER?: DurableObjectNamespace;
  [key: string]: unknown;
};

export const MERCHANT_HOST_INTERNAL_SECRET_HEADER =
  "x-nominee-host-internal-secret";

/**
 * Build ledger ports from Worker env inside the Durable Object isolate.
 * Production wiring (Task Authority, account service, payment provider) is not implemented in this slice.
 */
export function merchantLedgerPortsFromEnv(
  _env: MerchantLedgerEnv,
): MerchantLedgerPorts {
  throw new Error("merchant_ports_unconfigured");
}

/** Resolve pinned outbound fetch for CIBA client/deps inside a DO isolate. */
export function resolveSubrequestFetch(env: MerchantLedgerEnv): typeof fetch {
  const bound = env.SUBREQUEST_FETCH;
  if (typeof bound === "function") return bound;
  if (bound && typeof bound === "object" && typeof bound.fetch === "function") {
    return (input, init) => bound.fetch(input, init);
  }
  return fetch;
}

export function readHostInternalSecret(
  env: MerchantLedgerEnv,
): string | undefined {
  const value = env.MERCHANT_HOST_INTERNAL_SECRET;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
