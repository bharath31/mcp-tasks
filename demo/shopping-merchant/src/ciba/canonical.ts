import type { GuardianPurchaseAuthorizationDetails } from "../approval/types.js";

/** Canonical JSON for exact authorization_details comparison (offline, deterministic). */
export function canonicalAuthorizationDetailsJson(
  details: GuardianPurchaseAuthorizationDetails | unknown,
): string {
  return JSON.stringify(details);
}

export function authorizationDetailsExactlyMatch(
  expectedJson: string,
  received: unknown[],
): boolean {
  if (received.length !== 1) return false;
  return canonicalAuthorizationDetailsJson(received[0]) === expectedJson;
}
