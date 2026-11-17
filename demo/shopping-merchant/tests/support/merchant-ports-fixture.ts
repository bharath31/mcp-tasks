/**
 * Test Miniflare bundle only — replaces src/port-env.ts via esbuild alias.
 * Never import from deployable Worker/DO source.
 */
import {
  createFixtureApprovalVerifier,
  createFixtureCustomerAccount,
  createFixtureOrderProvider,
} from "./fixtures.js";
import type { MerchantLedgerPorts, Quote } from "../../src/types.js";

export type MerchantLedgerEnv = {
  MERCHANT_HOST_INTERNAL_SECRET?: string;
  LEDGER?: DurableObjectNamespace;
  [key: string]: unknown;
};

export const MERCHANT_HOST_INTERNAL_SECRET_HEADER = "x-nominee-host-internal-secret";

let fixtureVerifier: ReturnType<typeof createFixtureApprovalVerifier> | undefined;

export function merchantLedgerPortsFromEnv(_env: MerchantLedgerEnv): MerchantLedgerPorts {
  fixtureVerifier = createFixtureApprovalVerifier();
  return {
    customerAccount: createFixtureCustomerAccount(),
    verifyCustomerApproval: fixtureVerifier,
    orderProvider: createFixtureOrderProvider(),
  };
}

/** Record test approval inside the DO isolate (simulates verified customer proof). */
export function fixtureApproveQuoteForTest(quote: Quote): void {
  if (!fixtureVerifier) {
    throw new Error("fixture_ports_uninitialized");
  }
  fixtureVerifier.approveForTest(quote);
}

export function readHostInternalSecret(env: MerchantLedgerEnv): string | undefined {
  const value = env.MERCHANT_HOST_INTERNAL_SECRET;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}