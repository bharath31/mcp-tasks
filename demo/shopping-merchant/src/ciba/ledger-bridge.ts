import { buildGuardianPurchaseAuthorizationDetails } from "../approval/guardian-transaction-details.js";
import { catalogProduct } from "../catalog.js";
import type { SqlDatabase, SqlRow } from "../sql.js";
import type { HumanActor, Quote } from "../types.js";
import { canonicalAuthorizationDetailsJson } from "./canonical.js";

const fail = (): never => {
  throw new Error("not_found_or_forbidden");
};

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function requireRow(row: SqlRow | null): SqlRow {
  if (!row) return fail();
  return row;
}

function validateHumanActor(actor: HumanActor, customerId: string): void {
  if (
    !actor ||
    actor.kind !== "human" ||
    !nonempty(actor.customerId) ||
    !Array.isArray(actor.scopes)
  ) {
    fail();
  }
  if (actor.customerId !== customerId) fail();
}

function quoteView(data: string): Quote {
  return JSON.parse(data) as Quote;
}

function pricedItems(row: SqlRow): Quote["items"] {
  const items = JSON.parse(row.items as string) as {
    productId: string;
    quantity: number;
    priceMinor?: number;
    currency?: string;
  }[];
  if (!items.length) throw new Error("empty_cart");
  return items.map((item) => {
    const product = catalogProduct(item.productId);
    if (
      !product ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 100 ||
      item.priceMinor !== product.priceMinor ||
      item.currency !== product.currency
    ) {
      throw new Error("stale_cart_price");
    }
    return {
      productId: product.id,
      name: product.name,
      quantity: item.quantity,
      priceMinor: product.priceMinor,
      currency: product.currency,
    };
  });
}

function readChallengeRow(row: SqlRow) {
  return {
    id: String(row.id),
    status: String(row.status),
    customerId: String(row.customer_id),
    agentId:
      row.agent_id === null || row.agent_id === undefined
        ? null
        : String(row.agent_id),
    sessionId:
      row.session_id === null || row.session_id === undefined
        ? null
        : String(row.session_id),
    quoteId: String(row.quote_id),
    quoteRevision: Number(row.quote_revision),
    operationId: String(row.operation_id),
    quoteExpiresAt: String(row.quote_expires_at),
    quoteSnapshot: JSON.parse(String(row.quote_snapshot)) as Quote,
    canonicalAuthorizationDetailsJson: String(
      row.canonical_authorization_details_json,
    ),
    challengeExpiresAtMs: Number(row.challenge_expires_at_ms),
    consumedAtMs:
      row.consumed_at_ms === null || row.consumed_at_ms === undefined
        ? null
        : Number(row.consumed_at_ms),
  };
}

export type RecordCibaLedgerApprovalInput = {
  challengeId: string;
  /** Routing hint only; persisted challenge + ledger rows are authoritative. */
  quote: Quote;
  actor: HumanActor;
};

export type RecordCibaLedgerApprovalResult = {
  status: "approval_recorded";
  quoteId: string;
  operationId: string;
  revision: number;
  challengeId: string;
};

export type RecordCibaLedgerApprovalOptions = {
  nowMs?: number;
  /** When set, current quote must still encode to the challenge's authorization_details fingerprint. */
  merchantDisplayName?: string;
};

/**
 * Atomically consumes an approved, unconsumed CIBA challenge and inserts a ledger customer approval.
 * Must run inside the same customer DO SQLite database as the merchant ledger (single transaction, no await).
 */
export function recordApprovalWithConsumedChallenge(
  db: SqlDatabase,
  customerId: string,
  input: RecordCibaLedgerApprovalInput,
  options?: RecordCibaLedgerApprovalOptions,
): RecordCibaLedgerApprovalResult {
  if (!nonempty(customerId)) throw new Error("customer_id_required");
  validateHumanActor(input.actor, customerId);
  const nowMs = options?.nowMs ?? Date.now();

  return db.transaction(() => {
    const raw = db
      .exec(
        "SELECT * FROM purchase_ciba_challenges WHERE id = ?",
        input.challengeId,
      )
      .one();
    if (!raw) throw new Error("challenge_not_found");
    const challenge = readChallengeRow(raw);

    if (challenge.customerId !== customerId) fail();
    if (
      input.quote.id !== challenge.quoteId ||
      input.quote.operationId !== challenge.operationId ||
      input.quote.revision !== challenge.quoteRevision
    ) {
      throw new Error("challenge_quote_mismatch");
    }

    if (challenge.status !== "approved") {
      throw new Error("challenge_not_approved");
    }
    if (challenge.consumedAtMs !== null) {
      throw new Error("challenge_already_consumed");
    }
    if (challenge.challengeExpiresAtMs <= nowMs) {
      throw new Error("challenge_expired");
    }

    const record = requireRow(
      db.exec("SELECT * FROM quotes WHERE id = ?", challenge.quoteId).one(),
    );
    const cartRow = requireRow(
      db
        .exec(
          "SELECT * FROM carts WHERE id = ? AND customer_id = ?",
          record.cart_id,
          customerId,
        )
        .one(),
    );
    const operation = db
      .exec(
        "SELECT * FROM checkout_operations WHERE cart_id = ?",
        record.cart_id,
      )
      .one();
    const currentQuote = quoteView(record.data as string);

    if (currentQuote.customerId !== customerId) fail();
    if (currentQuote.id !== challenge.quoteId) {
      throw new Error("challenge_quote_mismatch");
    }
    if (challenge.agentId !== null) {
      if (
        cartRow.agent_id !== challenge.agentId ||
        currentQuote.agentId !== challenge.agentId
      ) {
        throw new Error("challenge_agent_mismatch");
      }
    }
    if (challenge.sessionId !== null) {
      if (cartRow.session_id !== challenge.sessionId) {
        throw new Error("challenge_session_mismatch");
      }
    }

    if (
      !operation ||
      operation.operation_id !== challenge.operationId ||
      operation.revision !== challenge.quoteRevision ||
      operation.operation_id !== currentQuote.operationId ||
      operation.revision !== currentQuote.revision ||
      (cartRow.version as number) !== currentQuote.cartVersion ||
      nowMs >= Date.parse(currentQuote.expiresAt) ||
      Date.parse(currentQuote.expiresAt) !== Date.parse(challenge.quoteExpiresAt) ||
      JSON.stringify(currentQuote) !== JSON.stringify(challenge.quoteSnapshot) ||
      JSON.stringify(pricedItems(cartRow)) !== JSON.stringify(currentQuote.items)
    ) {
      throw new Error("stale_quote");
    }

    if (options?.merchantDisplayName) {
      const details = buildGuardianPurchaseAuthorizationDetails({
        quote: currentQuote,
        merchantDisplayName: options.merchantDisplayName,
        nowMs,
      });
      if (
        canonicalAuthorizationDetailsJson(details) !==
        challenge.canonicalAuthorizationDetailsJson
      ) {
        throw new Error("challenge_terms_mismatch");
      }
    }

    db.exec(
      `UPDATE purchase_ciba_challenges
       SET consumed_at_ms = ?
       WHERE id = ? AND status = 'approved' AND consumed_at_ms IS NULL`,
      nowMs,
      input.challengeId,
    );
    const after = db
      .exec(
        "SELECT consumed_at_ms FROM purchase_ciba_challenges WHERE id = ?",
        input.challengeId,
      )
      .one();
    if (!after || Number(after.consumed_at_ms) !== nowMs) {
      throw new Error("challenge_consume_failed");
    }

    db.exec(
      `INSERT INTO quote_customer_approvals
       VALUES (?, ?, ?, ?, ?)`,
      currentQuote.id,
      currentQuote.operationId,
      currentQuote.revision,
      currentQuote.customerId,
      new Date(nowMs).toISOString(),
    );

    return {
      status: "approval_recorded" as const,
      quoteId: currentQuote.id,
      operationId: currentQuote.operationId,
      revision: currentQuote.revision,
      challengeId: input.challengeId,
    };
  });
}

export type CustomerApprovalLedgerBridge = {
  recordApprovalWithConsumedChallenge(
    input: RecordCibaLedgerApprovalInput,
  ): Promise<RecordCibaLedgerApprovalResult>;
};

export function createCustomerApprovalLedgerBridge(
  db: SqlDatabase,
  customerId: string,
  options?: Omit<RecordCibaLedgerApprovalOptions, "nowMs"> & {
    now?: () => number;
  },
): CustomerApprovalLedgerBridge {
  return {
    async recordApprovalWithConsumedChallenge(input) {
      return recordApprovalWithConsumedChallenge(db, customerId, input, {
        merchantDisplayName: options?.merchantDisplayName,
        nowMs: options?.now?.() ?? Date.now(),
      });
    },
  };
}