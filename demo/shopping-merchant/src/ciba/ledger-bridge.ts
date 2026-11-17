import type { HumanActor, Quote } from "../types.js";

/**
 * Explicit blocker: customer approval on the merchant ledger must atomically consume an
 * approved CIBA challenge in the same durable transaction. Do not wire `verifyCustomerApproval`
 * from CIBA output until this bridge is implemented on the host store.
 */
export type CustomerApprovalLedgerBridge = {
  recordApprovalWithConsumedChallenge(_input: {
    challengeId: string;
    quote: Quote;
    actor: HumanActor;
  }): Promise<never>;
};

export const LEDGER_CIBA_WIRING_BLOCKED =
  "ledger_ciba_atomic_consume_not_implemented" as const;
