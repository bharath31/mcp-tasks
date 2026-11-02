// Customer-owned task persistence (tasks + events + warehouse receipts).
// No grant/approval/claim state lives here.
import { readFile } from "node:fs/promises";
import pg from "pg";

export type TaskStatus =
  "working" | "input_required" | "completed" | "failed" | "cancelled";
export type Stage =
  | "awaiting_input"
  | "awaiting_return"
  | "awaiting_approval"
  | "ready"
  | "dispatching"
  | "reconciling"
  | "finished";

export type RefundRequest = {
  orderId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  exceptionNote?: string;
};
export type Task = {
  taskId: string;
  ownerSub: string;
  orgId: string;
  agentId: string;
  operationKey: string;
  delegationId: string | null;
  operationId: string | null;
  operationDigest: string | null;
  request: RefundRequest;
  payment: {
    amountMinor: number;
    refundedMinor: number;
    currency: string;
  } | null;
  status: TaskStatus;
  stage: Stage;
  statusMessage: string | null;
  inputRequests: Record<string, unknown> | null;
  answeredInputs: string[];
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  receipt: { eventId: string; reference: string } | null;
  attempts: number;
  failures: number;
  claimId: string | null;
  providerReference: string | null;
  dispatchedAt: Date | null;
  nextRunAt: Date;
  pollIntervalMs: number;
  createdAt: Date;
  updatedAt: Date;
  retainUntil: Date;
  version: number;
};

export class ConflictError extends Error {}

const COLS = `task_id, owner_sub, org_id, agent_id, operation_key, delegation_id, operation_id, operation_digest, request, payment, status, stage, status_message, input_requests, answered_inputs, result, error, receipt, attempts, failures, claim_id, provider_reference, dispatched_at, next_run_at, poll_interval_ms, created_at, updated_at, retain_until, version`;
const toTask = (r: any): Task => ({
  taskId: r.task_id,
  ownerSub: r.owner_sub,
  orgId: r.org_id,
  agentId: r.agent_id,
  operationKey: r.operation_key,
  delegationId: r.delegation_id,
  operationId: r.operation_id,
  operationDigest: r.operation_digest,
  request: r.request,
  payment: r.payment,
  status: r.status,
  stage: r.stage,
  statusMessage: r.status_message,
  inputRequests: r.input_requests,
  answeredInputs: r.answered_inputs,
  result: r.result,
  error: r.error,
  receipt: r.receipt,
  attempts: r.attempts,
  failures: r.failures,
  claimId: r.claim_id,
  providerReference: r.provider_reference,
  dispatchedAt: r.dispatched_at,
  nextRunAt: r.next_run_at,
  pollIntervalMs: r.poll_interval_ms,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  retainUntil: r.retain_until,
  version: r.version,
});

export const MIGRATION = new URL(
  "../migrations/0001_init.sql",
  import.meta.url,
);

export class Repository {
  constructor(
    readonly pool: pg.Pool,
    private now: () => number = Date.now,
  ) {}
  static connect(url: string, now?: () => number) {
    return new Repository(
      new pg.Pool({
        connectionString: url,
        max: 8,
        application_name: "refund-desk",
      }),
      now,
    );
  }
  async migrate() {
    const c = await this.pool.connect();
    try {
      await c.query("select pg_advisory_lock(7447003)");
      const have = await c.query("select to_regclass('refund_desk.tasks') t");
      if (!have.rows[0].t) await c.query(await readFile(MIGRATION, "utf8"));
    } finally {
      await c
        .query("select pg_advisory_unlock(7447003)")
        .catch(() => undefined);
      c.release();
    }
  }
  async ping() {
    await this.pool.query("select 1");
  }
  async close() {
    await this.pool.end();
  }
  private ts = (ms: number | Date) => new Date(ms).toISOString();

  async get(taskId: string) {
    const r = await this.pool.query(
      `select ${COLS} from refund_desk.tasks where task_id=$1`,
      [taskId],
    );
    return r.rows[0] ? toTask(r.rows[0]) : null;
  }

  async findByOperationId(operationId: string) {
    const result = await this.pool.query(
      "select * from refund_desk.tasks where operation_id=$1",
      [operationId],
    );
    return result.rows[0] ? toTask(result.rows[0]) : null;
  }
  async findByKey(orgId: string, operationKey: string) {
    const r = await this.pool.query(
      `select ${COLS} from refund_desk.tasks where org_id=$1 and operation_key=$2`,
      [orgId, operationKey],
    );
    return r.rows[0] ? toTask(r.rows[0]) : null;
  }
  async findForEvent(orgId: string, orderId: string, paymentId: string) {
    const r = await this.pool.query(
      `select ${COLS} from refund_desk.tasks where org_id=$1 and request->>'orderId'=$2 and request->>'paymentId'=$3 and stage='awaiting_return' order by created_at limit 1`,
      [orgId, orderId, paymentId],
    );
    return r.rows[0] ? toTask(r.rows[0]) : null;
  }
  async due(limit = 25) {
    const r = await this.pool.query(
      `select ${COLS} from refund_desk.tasks where (status = 'working' or (status = 'input_required' and stage = 'awaiting_approval')) and next_run_at <= $1 order by next_run_at limit $2`,
      [this.ts(this.now()), limit],
    );
    return r.rows.map(toTask);
  }
  async insert(t: Task) {
    try {
      await this.pool.query(
        `insert into refund_desk.tasks (${COLS}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
        [
          t.taskId,
          t.ownerSub,
          t.orgId,
          t.agentId,
          t.operationKey,
          t.delegationId,
          t.operationId,
          t.operationDigest,
          JSON.stringify(t.request),
          JSON.stringify(t.payment),
          t.status,
          t.stage,
          t.statusMessage,
          JSON.stringify(t.inputRequests),
          JSON.stringify(t.answeredInputs),
          JSON.stringify(t.result),
          JSON.stringify(t.error),
          JSON.stringify(t.receipt),
          t.attempts,
          t.failures,
          t.claimId,
          t.providerReference,
          t.dispatchedAt ? this.ts(t.dispatchedAt) : null,
          this.ts(t.nextRunAt),
          t.pollIntervalMs,
          this.ts(t.createdAt),
          this.ts(t.updatedAt),
          this.ts(t.retainUntil),
          t.version,
        ],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new ConflictError("duplicate_operation");
      throw e;
    }
    return t;
  }
  /** Compare-and-swap save: the version is the lease. */
  async save(t: Task): Promise<Task> {
    const next = {
      ...t,
      version: t.version + 1,
      updatedAt: new Date(this.now()),
    };
    const r = await this.pool.query(
      `update refund_desk.tasks set delegation_id=$3, operation_id=$4, operation_digest=$5, payment=$6, status=$7, stage=$8,
         status_message=$9, input_requests=$10, answered_inputs=$11, result=$12, error=$13, receipt=$14, attempts=$15,
         failures=$16, claim_id=$17, provider_reference=$18, next_run_at=$19, poll_interval_ms=$20, updated_at=$21,
         version=$22, request=$23, dispatched_at=$24
       where task_id=$1 and version=$2`,
      [
        t.taskId,
        t.version,
        t.delegationId,
        t.operationId,
        t.operationDigest,
        JSON.stringify(t.payment),
        t.status,
        t.stage,
        t.statusMessage,
        JSON.stringify(t.inputRequests),
        JSON.stringify(t.answeredInputs),
        JSON.stringify(t.result),
        JSON.stringify(t.error),
        JSON.stringify(t.receipt),
        t.attempts,
        t.failures,
        t.claimId,
        t.providerReference,
        this.ts(t.nextRunAt),
        t.pollIntervalMs,
        this.ts(next.updatedAt),
        next.version,
        JSON.stringify(t.request),
        t.dispatchedAt ? this.ts(t.dispatchedAt) : null,
      ],
    );
    if (!r.rowCount) throw new ConflictError("conflict_reload");
    return next;
  }
  async event(taskId: string, actor: string, event: string, detail: string) {
    await this.pool.query(
      "insert into refund_desk.task_events (task_id, at, actor, event, detail) values ($1,$2,$3,$4,$5)",
      [taskId, this.ts(this.now()), actor, event, detail],
    );
  }
  async events(taskId: string) {
    const r = await this.pool.query(
      "select at, actor, event, detail from refund_desk.task_events where task_id=$1 order by id",
      [taskId],
    );
    return r.rows.map((x) => ({
      at: new Date(x.at).toISOString(),
      actor: x.actor as string,
      event: x.event as string,
      detail: x.detail as string,
    }));
  }
  /**
   * Atomic ingestion of a verified warehouse event: the receipt row and the task
   * transition commit together, so a duplicate delivery can never apply twice.
   */
  async recordWarehouseEvent(e: {
    eventId: string;
    orgId: string;
    orderId: string;
    paymentId: string;
    reference: string;
  }) {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const ins = await c.query(
        "insert into refund_desk.warehouse_events (event_id, org_id, order_id, payment_id, reference, received_at) values ($1,$2,$3,$4,$5,$6) on conflict (event_id) do nothing returning event_id",
        [
          e.eventId,
          e.orgId,
          e.orderId,
          e.paymentId,
          e.reference,
          this.ts(this.now()),
        ],
      );
      if (!ins.rowCount) {
        await c.query("commit");
        return { duplicate: true as const, task: null };
      }
      const t = (
        await c.query(
          `select ${COLS} from refund_desk.tasks where org_id=$1 and request->>'orderId'=$2 and request->>'paymentId'=$3 and stage='awaiting_return' order by created_at limit 1 for update`,
          [e.orgId, e.orderId, e.paymentId],
        )
      ).rows[0];
      if (t) {
        await c.query(
          "update refund_desk.warehouse_events set applied_task_id=$2 where event_id=$1",
          [e.eventId, t.task_id],
        );
        await c.query(
          "update refund_desk.tasks set receipt=$2, stage='awaiting_approval', status_message=$3, next_run_at=$4, updated_at=$4, version=version+1 where task_id=$1",
          [
            t.task_id,
            JSON.stringify({ eventId: e.eventId, reference: e.reference }),
            "Return verified by warehouse event. Evaluating refund authorization.",
            this.ts(this.now()),
          ],
        );
        await c.query(
          "insert into refund_desk.task_events (task_id, at, actor, event, detail) values ($1,$2,'warehouse','return_received',$3)",
          [
            t.task_id,
            this.ts(this.now()),
            `Signed warehouse event ${e.eventId} verified.`,
          ],
        );
      }
      await c.query("commit");
      return {
        duplicate: false as const,
        task: t ? await this.get(t.task_id) : null,
      };
    } catch (err) {
      await c.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
  /** An event that arrived before its task: applied when the task is created. */
  async orphanEvent(orgId: string, orderId: string, paymentId: string) {
    const r = await this.pool.query(
      "select event_id, reference from refund_desk.warehouse_events where org_id=$1 and order_id=$2 and payment_id=$3 and applied_task_id is null order by received_at limit 1",
      [orgId, orderId, paymentId],
    );
    return r.rows[0]
      ? {
          eventId: r.rows[0].event_id as string,
          reference: r.rows[0].reference as string,
        }
      : null;
  }
  async markEventApplied(eventId: string, taskId: string) {
    await this.pool.query(
      "update refund_desk.warehouse_events set applied_task_id=$2 where event_id=$1",
      [eventId, taskId],
    );
  }
}
