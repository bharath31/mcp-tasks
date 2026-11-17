import type {
  ChallengeLifecycle,
  PurchaseCibaChallenge,
} from "./challenge-types.js";

export type ChallengeTransitionResult =
  | { ok: true; challenge: PurchaseCibaChallenge }
  | { ok: false; reason: "not_found" | "state_conflict" | "already_consumed" };

/**
 * Durable challenge storage with single-use, conditional lifecycle transitions.
 * Implementations must be safe under concurrent polls (exactly one winner per approval).
 */
export type PurchaseCibaChallengeStore = {
  insertStarting(challenge: PurchaseCibaChallenge): Promise<boolean>;
  get(id: string): Promise<PurchaseCibaChallenge | null>;
  transition(
    id: string,
    from: ChallengeLifecycle[],
    to: ChallengeLifecycle,
    patch: Partial<PurchaseCibaChallenge>,
  ): Promise<ChallengeTransitionResult>;
  /**
   * Claim one poll attempt when `nowMs >= nextPollAtMs` and status is `polling`.
   * Returns null when another worker holds the slot or the schedule is not due.
   */
  claimPoll(id: string, nowMs: number): Promise<PurchaseCibaChallenge | null>;
  consumeApproved(
    id: string,
    nowMs: number,
  ): Promise<ChallengeTransitionResult>;
};
