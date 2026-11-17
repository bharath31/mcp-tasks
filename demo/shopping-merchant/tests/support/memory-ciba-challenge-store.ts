import type { PurchaseCibaChallenge } from "../../src/ciba/challenge-types.js";
import type { PurchaseCibaChallengeStore } from "../../src/ciba/challenge-store.js";

/** In-memory challenge store for unit tests (single isolate; not durable). */
export function createMemoryCibaChallengeStore(): PurchaseCibaChallengeStore {
  const rows = new Map<string, PurchaseCibaChallenge>();
  const claimedPollSlot = new Map<string, number>();

  const clone = (c: PurchaseCibaChallenge) => structuredClone(c);

  return {
    async insertStarting(challenge) {
      if (rows.has(challenge.id)) return false;
      rows.set(challenge.id, clone(challenge));
      return true;
    },
    async get(id) {
      const row = rows.get(id);
      return row ? clone(row) : null;
    },
    async transition(id, from, to, patch) {
      const row = rows.get(id);
      if (!row) return { ok: false, reason: "not_found" };
      if (!from.includes(row.status)) {
        return { ok: false, reason: "state_conflict" };
      }
      if (row.consumedAtMs !== null && to === "approved") {
        return { ok: false, reason: "already_consumed" };
      }
      Object.assign(row, patch, { status: to });
      if (to === "polling" && patch.nextPollAtMs !== undefined) {
        claimedPollSlot.delete(id);
      }
      return { ok: true, challenge: clone(row) };
    },
    async claimPoll(id, nowMs) {
      const row = rows.get(id);
      if (!row || row.status !== "polling") return null;
      if (nowMs < row.nextPollAtMs) return null;
      if (claimedPollSlot.get(id) === row.nextPollAtMs) return null;
      claimedPollSlot.set(id, row.nextPollAtMs);
      return clone(row);
    },
    async consumeApproved(id, nowMs) {
      const row = rows.get(id);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.status !== "approved")
        return { ok: false, reason: "state_conflict" };
      if (row.consumedAtMs !== null) {
        return { ok: false, reason: "already_consumed" };
      }
      row.consumedAtMs = nowMs;
      return { ok: true, challenge: clone(row) };
    },
  };
}
