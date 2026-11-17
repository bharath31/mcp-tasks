import type { SqlDatabase, SqlRow } from "../sql.js";
import type {
  ChallengeLifecycle,
  PurchaseCibaChallenge,
} from "./challenge-types.js";
import type {
  ChallengeTransitionResult,
  PurchaseCibaChallengeStore,
} from "./challenge-store.js";

function readOptionalString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return String(value);
}

function readChallengeRow(row: SqlRow): PurchaseCibaChallenge {
  return {
    id: String(row.id),
    status: String(row.status) as ChallengeLifecycle,
    customerId: String(row.customer_id),
    agentId: readOptionalString(row, "agent_id"),
    sessionId: readOptionalString(row, "session_id"),
    quoteId: String(row.quote_id),
    quoteRevision: Number(row.quote_revision),
    operationId: String(row.operation_id),
    quoteExpiresAt: String(row.quote_expires_at),
    quoteSnapshot: JSON.parse(String(row.quote_snapshot)),
    canonicalAuthorizationDetailsJson: String(
      row.canonical_authorization_details_json,
    ),
    authReqId: readOptionalString(row, "auth_req_id"),
    pollIntervalSec: Number(row.poll_interval_sec),
    nextPollAtMs: Number(row.next_poll_at_ms),
    challengeExpiresAtMs: Number(row.challenge_expires_at_ms),
    createdAtMs: Number(row.created_at_ms),
    decidedAtMs:
      row.decided_at_ms === null || row.decided_at_ms === undefined
        ? null
        : Number(row.decided_at_ms),
    consumedAtMs:
      row.consumed_at_ms === null || row.consumed_at_ms === undefined
        ? null
        : Number(row.consumed_at_ms),
    failureCode: readOptionalString(row, "failure_code"),
  };
}

function selectChallenge(
  db: SqlDatabase,
  id: string,
): PurchaseCibaChallenge | null {
  const row = db
    .exec("SELECT * FROM purchase_ciba_challenges WHERE id = ?", id)
    .one();
  return row ? readChallengeRow(row) : null;
}

/**
 * Durable per-DO SQLite challenge store with conditional updates inside
 * `transactionSync` / BEGIN IMMEDIATE — safe for concurrent poll claims.
 */
export function createSqlCibaChallengeStore(
  db: SqlDatabase,
): PurchaseCibaChallengeStore {
  return {
    async insertStarting(challenge) {
      return db.transaction(() => {
        if (selectChallenge(db, challenge.id)) return false;
        db.exec(
          `INSERT INTO purchase_ciba_challenges (
            id, status, customer_id, agent_id, session_id,
            quote_id, quote_revision, operation_id, quote_expires_at,
            quote_snapshot, canonical_authorization_details_json,
            auth_req_id, poll_interval_sec, next_poll_at_ms,
            challenge_expires_at_ms, created_at_ms, decided_at_ms,
            consumed_at_ms, failure_code, poll_claim_slot
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          challenge.id,
          challenge.status,
          challenge.customerId,
          challenge.agentId,
          challenge.sessionId,
          challenge.quoteId,
          challenge.quoteRevision,
          challenge.operationId,
          challenge.quoteExpiresAt,
          JSON.stringify(challenge.quoteSnapshot),
          challenge.canonicalAuthorizationDetailsJson,
          challenge.authReqId,
          challenge.pollIntervalSec,
          challenge.nextPollAtMs,
          challenge.challengeExpiresAtMs,
          challenge.createdAtMs,
          challenge.decidedAtMs,
          challenge.consumedAtMs,
          challenge.failureCode,
          null,
        );
        return true;
      });
    },

    async get(id) {
      const row = selectChallenge(db, id);
      return row ? structuredClone(row) : null;
    },

    async transition(id, from, to, patch) {
      return db.transaction(() => {
        const raw = db
          .exec("SELECT * FROM purchase_ciba_challenges WHERE id = ?", id)
          .one();
        if (!raw) return { ok: false as const, reason: "not_found" };
        const row = readChallengeRow(raw);
        if (!from.includes(row.status)) {
          return { ok: false as const, reason: "state_conflict" };
        }
        if (row.consumedAtMs !== null && to === "approved") {
          return { ok: false as const, reason: "already_consumed" };
        }
        const pollClaimSlot =
          raw.poll_claim_slot === null || raw.poll_claim_slot === undefined
            ? null
            : Number(raw.poll_claim_slot);
        const next: PurchaseCibaChallenge = {
          ...row,
          ...patch,
          status: to,
        };
        const clearPollClaim =
          to === "polling" && patch.nextPollAtMs !== undefined;
        db.exec(
          `UPDATE purchase_ciba_challenges SET
            status = ?,
            customer_id = ?,
            agent_id = ?,
            session_id = ?,
            quote_id = ?,
            quote_revision = ?,
            operation_id = ?,
            quote_expires_at = ?,
            quote_snapshot = ?,
            canonical_authorization_details_json = ?,
            auth_req_id = ?,
            poll_interval_sec = ?,
            next_poll_at_ms = ?,
            challenge_expires_at_ms = ?,
            created_at_ms = ?,
            decided_at_ms = ?,
            consumed_at_ms = ?,
            failure_code = ?,
            poll_claim_slot = ?
           WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
          next.status,
          next.customerId,
          next.agentId,
          next.sessionId,
          next.quoteId,
          next.quoteRevision,
          next.operationId,
          next.quoteExpiresAt,
          JSON.stringify(next.quoteSnapshot),
          next.canonicalAuthorizationDetailsJson,
          next.authReqId,
          next.pollIntervalSec,
          next.nextPollAtMs,
          next.challengeExpiresAtMs,
          next.createdAtMs,
          next.decidedAtMs,
          next.consumedAtMs,
          next.failureCode,
          clearPollClaim ? null : pollClaimSlot,
          id,
          ...from,
        );
        const updated = selectChallenge(db, id);
        if (!updated || updated.status !== to) {
          return { ok: false as const, reason: "state_conflict" };
        }
        return { ok: true as const, challenge: structuredClone(updated) };
      });
    },

    async claimPoll(id, nowMs) {
      return db.transaction(() => {
        const row = db
          .exec("SELECT * FROM purchase_ciba_challenges WHERE id = ?", id)
          .one();
        if (!row) return null;
        const status = String(row.status);
        if (status !== "polling") return null;
        const nextPollAtMs = Number(row.next_poll_at_ms);
        if (nowMs < nextPollAtMs) return null;
        const claimSlot =
          row.poll_claim_slot === null || row.poll_claim_slot === undefined
            ? null
            : Number(row.poll_claim_slot);
        if (claimSlot === nextPollAtMs) return null;
        db.exec(
          `UPDATE purchase_ciba_challenges
           SET poll_claim_slot = ?
           WHERE id = ? AND status = 'polling' AND next_poll_at_ms = ?
             AND (poll_claim_slot IS NULL OR poll_claim_slot != next_poll_at_ms)`,
          nextPollAtMs,
          id,
          nextPollAtMs,
        );
        const after = db
          .exec(
            "SELECT poll_claim_slot FROM purchase_ciba_challenges WHERE id = ?",
            id,
          )
          .one();
        if (!after || Number(after.poll_claim_slot) !== nextPollAtMs) {
          return null;
        }
        const challenge = selectChallenge(db, id);
        return challenge ? structuredClone(challenge) : null;
      });
    },

    async consumeApproved(id, nowMs) {
      return db.transaction(() => {
        const row = selectChallenge(db, id);
        if (!row) return { ok: false as const, reason: "not_found" };
        if (row.status !== "approved") {
          return { ok: false as const, reason: "state_conflict" };
        }
        if (row.consumedAtMs !== null) {
          return { ok: false as const, reason: "already_consumed" };
        }
        db.exec(
          `UPDATE purchase_ciba_challenges
           SET consumed_at_ms = ?
           WHERE id = ? AND status = 'approved' AND consumed_at_ms IS NULL`,
          nowMs,
          id,
        );
        const updated = selectChallenge(db, id);
        if (!updated || updated.consumedAtMs !== nowMs) {
          return { ok: false as const, reason: "state_conflict" };
        }
        return { ok: true as const, challenge: structuredClone(updated) };
      });
    },
  };
}
