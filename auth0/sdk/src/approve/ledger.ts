// PostgreSQL ledger for non-durable callers (including MCP Tasks). The proof is
// verified before the atomic used_at update, so invalid proofs cannot burn a row
// and concurrent consumers can still win only once.
import {
  ApprovalError,
  ApprovalRejected,
  verifyApproval,
  type Approval,
  type ApprovalConfig,
  type ApprovalRequest,
  type ApprovalStore,
} from "./core.js";

export type ApprovalLedgerDb = {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
};

type LedgerRow = {
  request: ApprovalRequest | string;
  proof: string | null;
  used_at: Date | string | null;
};

const requestOf = (row: LedgerRow): ApprovalRequest =>
  typeof row.request === "string"
    ? (JSON.parse(row.request) as ApprovalRequest)
    : row.request;

export type ApprovalLedger = ApprovalStore & {
  deliver(id: string, proof: string): Promise<void>;
  consume(
    id: string,
    beforeConsume?: (
      request: ApprovalRequest,
      approval: Approval,
    ) => Promise<void>,
  ): Promise<Approval | null>;
};

export type PostgresApprovalLedgerOptions = { table?: string };

const tableName = (table: string) => {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(table))
    throw new TypeError(
      "Approval ledger table must be a simple SQL identifier.",
    );
  return table;
};

export function createPostgresApprovalLedger(
  db: ApprovalLedgerDb,
  cfg: ApprovalConfig,
  options: PostgresApprovalLedgerOptions = {},
): ApprovalLedger {
  const table = tableName(options.table ?? "approval_requests");
  return {
    async put(id, request) {
      if (request.id !== id)
        throw new ApprovalError(
          "invalid_request",
          "Ledger id must match the approval request.",
        );
      await db.query(
        `insert into ${table} as ledger (id, request, expires_at)
         values ($1, $2::jsonb, to_timestamp($3))
         on conflict (id) do update set request=excluded.request, expires_at=excluded.expires_at
         where ledger.used_at is null`,
        [id, JSON.stringify(request), request.exp],
      );
    },
    async get(id) {
      const row = (
        await db.query(
          `select request from ${table} where id=$1 and expires_at>now()`,
          [id],
        )
      ).rows[0];
      return row ? requestOf(row as LedgerRow) : undefined;
    },
    async deliver(id, proof) {
      // Validate before persisting. A validly signed token from the wrong user must
      // not occupy the request forever and prevent the entitled approver from acting.
      const row = (
        await db.query(
          `select request, proof, used_at from ${table}
           where id=$1 and expires_at>now()`,
          [id],
        )
      ).rows[0];
      if (!row || row.used_at)
        throw new ApprovalError(
          "expired",
          "The approval request is missing, expired, or already used.",
        );
      const request = requestOf(row);
      await verifyApproval(cfg, request, proof);
      const result = await db.query(
        `update ${table} set proof=$2, decided_at=now()
         where id=$1 and proof is null and used_at is null and expires_at>now()
         returning id`,
        [id, proof],
      );
      if (result.rows.length === 0) {
        const state = (
          await db.query(
            `select id from ${table} where id=$1 and proof is not null and used_at is null and expires_at>now()`,
            [id],
          )
        ).rows[0];
        if (state) return; // duplicate delivery is idempotent; consume still verifies it.
        throw new ApprovalError(
          "expired",
          "The approval request is missing, expired, or already used.",
        );
      }
    },
    async consume(id, beforeConsume) {
      const row = (
        await db.query(
          `select request, proof, used_at from ${table} where id=$1 and expires_at>now()`,
          [id],
        )
      ).rows[0];
      if (!row || row.used_at || !row.proof) return null;
      const request = requestOf(row);
      const approval = await verifyApproval(cfg, request, row.proof);
      const used = await db.query(
        `update ${table} set used_at=now()
         where id=$1 and proof=$2 and used_at is null and expires_at>now()
         returning id`,
        [id, row.proof],
      );
      if (!used.rows.length) return null;
      if (approval.decision === "reject") throw new ApprovalRejected(approval);
      // Claim the proof before running an effect. The database's idempotency key
      // protects recovery if the process stops after the claim and before replying.
      await beforeConsume?.(request, approval);
      return approval;
    },
  };
}
