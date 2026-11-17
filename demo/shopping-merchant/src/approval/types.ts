import type { GUARDIAN_PURCHASE_AUTHORIZATION_DETAILS_TYPE } from "./constants.js";

export type GuardianAuthorizationProperty = {
  display: boolean;
  name: string;
  display_order: number;
  description?: string;
  value: string | number | boolean;
};

/** Single-object Guardian RAR payload (not wired to live CIBA or push). */
export type GuardianPurchaseAuthorizationDetails = {
  type: typeof GUARDIAN_PURCHASE_AUTHORIZATION_DETAILS_TYPE;
  instruction: string;
  properties: Record<string, GuardianAuthorizationProperty>;
};

export type BuildGuardianPurchaseAuthorizationDetailsInput = {
  quote: import("../types.js").Quote;
  /** Stable merchant display name from trusted host configuration, not client input. */
  merchantDisplayName: string;
  /** Test hook; defaults to Date.now(). */
  nowMs?: number;
};
