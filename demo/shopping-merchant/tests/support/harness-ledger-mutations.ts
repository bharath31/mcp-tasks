/**
 * Harness-only ledger / CIBA mutations — never import from deployable merchant src.
 */
import { createSqlCibaChallengeStore } from "../../src/ciba/sql-ciba-challenge-store.js";
import { initCibaChallengeSchema } from "../../src/ciba/schema.js";
import {
  createDoSqlDatabase,
  initMerchantSchema,
  type SqlDatabase,
} from "../../src/sql.js";
import type { Quote, TrustedActor } from "../../src/types.js";

export const HARNESS_SET_QUOTE_EXPIRES_OP = "harnessSetQuoteExpiresAt" as const;
export const HARNESS_CIBA_UNBRIDGED_OP =
  "harnessSetCibaChallengeApprovedUnbridged" as const;

function quoteFromRow(data: string): Quote {
  return JSON.parse(data) as Quote;
}

export function harnessOpenMerchantDatabase(
  storage: DurableObjectStorage,
): SqlDatabase {
  const db = createDoSqlDatabase(storage);
  initMerchantSchema(db);
  initCibaChallengeSchema(db);
  return db;
}

export function harnessSetQuoteExpiresAt(
  db: SqlDatabase,
  customerId: string,
  quoteId: string,
  expiresAt: string,
): Quote {
  const record = db.exec("SELECT * FROM quotes WHERE id = ?", quoteId).one();
  if (!record) throw new Error("not_found_or_forbidden");
  const quote = quoteFromRow(record.data as string);
  if (quote.customerId !== customerId)
    throw new Error("not_found_or_forbidden");
  const next = { ...quote, expiresAt };
  db.exec(
    "UPDATE quotes SET data = ? WHERE id = ?",
    JSON.stringify(next),
    quoteId,
  );
  return next;
}

export async function harnessSetCibaChallengeApprovedUnbridged(
  db: SqlDatabase,
  customerId: string,
  challengeId: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const store = createSqlCibaChallengeStore(db);
  const row = await store.get(challengeId);
  if (!row || row.customerId !== customerId) {
    return { error: "challenge_not_found", status: 404 };
  }
  if (row.status === "approved" && row.consumedAtMs == null) {
    return { ok: true };
  }
  const from =
    row.status === "starting" || row.status === "polling"
      ? ([row.status] as const)
      : null;
  if (!from) {
    return { error: "challenge_not_simulatable", status: 409 };
  }
  const transitioned = await store.transition(
    challengeId,
    [...from],
    "approved",
    {
      decidedAtMs: Date.now(),
    },
  );
  if (!transitioned.ok) {
    return { error: transitioned.reason, status: 409 };
  }
  return { ok: true };
}

export type HarnessLedgerMutationBody =
  | {
      op: typeof HARNESS_SET_QUOTE_EXPIRES_OP;
      actor: TrustedActor;
      quoteId: string;
      expiresAt: string;
    }
  | {
      op: typeof HARNESS_CIBA_UNBRIDGED_OP;
      actor: { kind: "human"; customerId: string; scopes: string[] };
      challengeId: string;
    };

export function isHarnessLedgerMutationOp(
  op: string | undefined,
): op is HarnessLedgerMutationBody["op"] {
  return (
    op === HARNESS_SET_QUOTE_EXPIRES_OP || op === HARNESS_CIBA_UNBRIDGED_OP
  );
}
