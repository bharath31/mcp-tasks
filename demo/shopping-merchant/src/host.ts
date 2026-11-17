/**
 * Trusted-host boundary for the merchant ledger.
 * The Worker verifies identity and passes TrustedActor values; they are never parsed from untrusted JSON alone.
 *
 * When state lives in a Durable Object, the Worker must call `hostInjectCustomerApproval` on the DO stub
 * (see {@link MERCHANT_HOST_INTERNAL_SECRET_HEADER} in port-env.ts) after identity proof — not public fetch actor JSON.
 */
import type { MerchantLedger } from "./ledger.js";
import {
  MERCHANT_HOST_INTERNAL_SECRET_HEADER,
  type MerchantLedgerEnv,
} from "./port-env.js";
import type { HumanActor, TrustedActor } from "./types.js";

export { MERCHANT_HOST_INTERNAL_SECRET_HEADER };

export type TrustedMerchantHost = {
  /** Customer-scoped ledger handle (one Durable Object per customer in production). */
  ledger: MerchantLedger;
  /**
   * Record verified customer approval after the host independently verified proof
   * (passkey, CIBA, Task Authority, etc.). No public /approve HTTP route exists.
   */
  injectCustomerApproval(quoteId: string, actor: HumanActor): ReturnType<
    MerchantLedger["injectCustomerApproval"]
  >;
  executeQuote(
    quoteId: string,
    actor: TrustedActor,
  ): ReturnType<MerchantLedger["executeQuote"]>;
};

export function createTrustedMerchantHost(ledger: MerchantLedger): TrustedMerchantHost {
  return {
    ledger,
    injectCustomerApproval(quoteId, actor) {
      return ledger.injectCustomerApproval(quoteId, actor);
    },
    executeQuote(quoteId, actor) {
      return ledger.executeQuote(quoteId, actor);
    },
  };
}

/** Worker-side transport into DO-hosted ledger after the host verified the human actor. */
export async function hostInjectCustomerApprovalOnStub(
  stub: DurableObjectStub,
  env: MerchantLedgerEnv,
  customerId: string,
  quoteId: string,
  actor: HumanActor,
): Promise<Response> {
  const secret = env.MERCHANT_HOST_INTERNAL_SECRET;
  if (typeof secret !== "string" || !secret.length) {
    throw new Error("customer_approval_host_unavailable");
  }
  return stub.fetch("http://ledger/internal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nominee-customer-id": customerId,
      [MERCHANT_HOST_INTERNAL_SECRET_HEADER]: secret,
    },
    body: JSON.stringify({
      op: "hostInjectCustomerApproval",
      quoteId,
      actor,
    }),
  });
}