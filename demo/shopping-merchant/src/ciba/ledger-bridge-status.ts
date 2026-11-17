import type { PurchaseCibaChallenge } from "./challenge-types.js";
import type { createMerchantLedger } from "../ledger.js";
import type { Quote } from "../types.js";

export function isPurchaseCibaLedgerBridged(
  ledger: ReturnType<typeof createMerchantLedger>,
  challenge: PurchaseCibaChallenge,
  quote: Quote,
): boolean {
  if (challenge.status !== "approved") return false;
  if (challenge.consumedAtMs == null) return false;
  return ledger.hasCustomerApprovalForQuote(quote);
}

/**
 * Customer-visible challenge status: store `approved` is not surfaced as approved
 * until the ledger bridge has consumed the challenge and recorded approval.
 */
export function customerFacingChallengeStatus(
  storeStatus: PurchaseCibaChallenge["status"],
  ledgerBridged: boolean,
  surface: "store" | "sanitized" = "store",
): PurchaseCibaChallenge["status"] | "polling" | "pending" {
  if (storeStatus === "approved" && !ledgerBridged) {
    return surface === "store" ? "polling" : "pending";
  }
  return storeStatus;
}
