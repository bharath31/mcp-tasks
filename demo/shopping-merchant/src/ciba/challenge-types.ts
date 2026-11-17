import type { Quote } from "../types.js";

export type ChallengeLifecycle =
  | "starting"
  | "polling"
  | "approved"
  | "denied"
  | "expired"
  | "failed"
  | "uncertain";

export type PurchaseCibaChallenge = {
  id: string;
  status: ChallengeLifecycle;
  customerId: string;
  agentId: string | null;
  sessionId: string | null;
  quoteId: string;
  quoteRevision: number;
  operationId: string;
  quoteExpiresAt: string;
  quoteSnapshot: Quote;
  canonicalAuthorizationDetailsJson: string;
  /** Server-held; never exposed in sanitized status or logs. */
  authReqId: string | null;
  pollIntervalSec: number;
  nextPollAtMs: number;
  challengeExpiresAtMs: number;
  createdAtMs: number;
  decidedAtMs: number | null;
  consumedAtMs: number | null;
  failureCode: string | null;
};

export type SanitizedChallengeStatus = {
  challengeId: string;
  status: "pending" | "approved" | "denied" | "expired" | "unavailable";
  quoteId: string;
  operationId: string;
  quoteRevision: number;
  /** Present for terminal failures; never includes secrets. */
  failureCode?: string;
};

export type TrustedChallengeContext = {
  /** From verified host identity, not raw client JSON. */
  customerId: string;
  agentId: string | null;
  sessionId: string | null;
  quote: Quote;
  merchantDisplayName: string;
  nowMs: number;
};
