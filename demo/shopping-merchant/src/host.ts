/**
 * Trusted-host boundary for the merchant ledger.
 * The Worker verifies identity and passes TrustedActor values; they are never parsed from untrusted JSON alone.
 */
import type { MerchantLedger } from "./ledger.js";
import type { HumanActor, TrustedActor } from "./types.js";

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