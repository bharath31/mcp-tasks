// Business validation and requester input. Approval rules live in Task Authority.
export type MerchantPolicy = {
  /** Above this, the requester must supply an exception note. */
  requireNoteAboveMinor: number;
};

export const NORTHSTAR_POLICY: MerchantPolicy = {
  requireNoteAboveMinor: 10_000,
};

export type Payment = { amountMinor: number; refundedMinor: number };
export type RefundFacts = {
  amountMinor: number;
  payment: { amountMinor: number; refundedMinor: number };
};

export function refundableMinor(p: {
  amountMinor: number;
  refundedMinor: number;
}) {
  return p.amountMinor - p.refundedMinor;
}
export function isEligible(f: RefundFacts) {
  return f.amountMinor > 0 && f.amountMinor <= refundableMinor(f.payment);
}
export function needsExceptionNote(
  policy: MerchantPolicy,
  amountMinor: number,
) {
  return amountMinor > policy.requireNoteAboveMinor;
}
