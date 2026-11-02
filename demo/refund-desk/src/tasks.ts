// Customer-owned MCP task lifecycle around the Task Authority SDK workflow.
// Task state is application-owned; authorization state is NOT stored here.
import {
  TaskAuthorityError,
  type ProtectedOutcome,
  OWNER_APPROVAL_INPUT,
  ownerApprovalInputKey,
} from "@task-authority/sdk";
import { z } from "zod";
import type { Principal } from "./auth.js";
import type { ProviderRefund } from "./payments.js";
import { needsExceptionNote } from "./policy.js";
import {
  ConflictError,
  type Repository,
  type Stage,
  type Task,
} from "./repository.js";
import { DispatchUncertain, type Caller, type Deps } from "./types.js";
import { authorize, dispatch, requestReview } from "./workflow.js";

export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly data?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export const refundInputSchema = z
  .object({
    orderId: z.string().trim().min(1).max(80),
    paymentId: z.string().trim().min(3).max(100),
    amountMinor: z.number().int().min(1).max(10_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    reason: z.string().trim().min(5).max(500),
    exceptionNote: z.string().trim().min(5).max(500).optional(),
  })
  .strict();
export type RefundInput = z.infer<typeof refundInputSchema>;

const RETAIN_MS = 7 * 86400_000;
const POLL_MS = 5_000;
const WAIT_MS = 15_000;
const MAX_FAILURES = 5;
const IDEMPOTENCY_WINDOW_GUARD_MS = 23 * 3600_000;
/**
 * Input-request keys are unique over a task's lifetime (MCP Tasks): a client deduplicates by
 * key and never answers a key twice, so every new request gets a new key. The first exception
 * note is `exception_note`, a re-ask after recovery `exception_note:2`, and so on.
 */
const NOTE_KEY = "exception_note";
const isNoteKey = (k: string) => k === NOTE_KEY || k.startsWith(`${NOTE_KEY}:`);
/**
 * URL-mode elicitation: the delegating user approves their agent's refund on the hosted page.
 * One key per approval, shared with the SDK's renderMcp. A bare `owner_approval` key is what
 * tasks saved before per-approval keys still hold outstanding.
 */
const OWNER_KEY = OWNER_APPROVAL_INPUT;
const ownerKey = ownerApprovalInputKey;
const isOwnerKey = (k: string) =>
  k === OWNER_KEY || k.startsWith(`${OWNER_KEY}:`);
const AUTHORIZE_LEASE_MS = 120_000;

export type ServiceOptions = Deps & {
  repo: Repository;
  /** Exchanges the MCP-audience token for the Task Authority audience (OBO). */
  subjectToken: (p: Principal) => Promise<string>;
  /** Public URL of the reviewer page. */
  reviewUrl: (approvalId: string, orgId: string) => string;
  providerMode: string;
  /** Read-only credential for the audit timeline (audit:read). Falls back to the API client. */
  auditor?: Deps["authority"];
  /**
   * How the owner is asked to approve their agent's refund. "elicitation" (default) asks in the
   * MCP client with a URL elicitation. "status" keeps the task working and puts the link in
   * statusMessage, for headless hosts: Claude Code cancels any task that asks for input in
   * `claude -p`, Agent SDK and GitHub Actions runs, which would withdraw the request.
   */
  ownerPrompt?: "elicitation" | "status";
};

export class RefundService {
  constructor(readonly o: ServiceOptions) {}
  private get repo() {
    return this.o.repo;
  }
  private now = () => this.o.now();

  async read(
    p: Pick<Principal, "sub" | "orgId">,
    taskId: string,
  ): Promise<Task> {
    const t = /^[0-9a-f-]{36}$/.test(taskId)
      ? await this.repo.get(taskId)
      : null;
    // Possessing a task id is never enough: owner and organization are re-checked.
    if (
      !t ||
      t.ownerSub !== p.sub ||
      t.orgId !== p.orgId ||
      t.retainUntil.getTime() <= this.now()
    )
      throw new AppError("task_not_found", 404);
    return t;
  }

  async create(p: Principal, raw: unknown): Promise<Task> {
    const parsed = refundInputSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("invalid_refund_request", 400);
    const req = parsed.data;
    const operationKey = `${p.orgId}:refund:${req.paymentId}:${req.orderId}:${req.amountMinor}`;
    const existing = await this.repo.findByKey(p.orgId, operationKey);
    if (existing) return this.reuse(existing, p, req);
    const now = this.now();
    const needNote =
      needsExceptionNote(this.o.policy, req.amountMinor) && !req.exceptionNote;
    const t: Task = {
      taskId: crypto.randomUUID(),
      ownerSub: p.sub,
      orgId: p.orgId,
      agentId: p.agentId,
      operationKey,
      delegationId: null,
      operationId: null,
      operationDigest: null,
      request: req,
      payment: null,
      status: needNote ? "input_required" : "working",
      stage: needNote ? "awaiting_input" : "awaiting_return",
      statusMessage: needNote
        ? "An exception note is required for this refund amount."
        : "Authorizing the refund request.",
      inputRequests: needNote
        ? this.noteRequest(req.amountMinor, req.currency)
        : null,
      answeredInputs: [],
      result: null,
      error: null,
      receipt: null,
      attempts: 0,
      failures: 0,
      claimId: null,
      providerReference: null,
      dispatchedAt: null,
      nextRunAt: new Date(now + 365 * 86400_000),
      pollIntervalMs: POLL_MS,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      retainUntil: new Date(now + RETAIN_MS),
      version: 1,
    };
    if (needNote) return this.insertOrRecover(t, p, req);
    return this.authorizeAndInsert(t, p);
  }

  /** The authority re-verifies the initiating/reviewing human before disclosing status. */
  async operationStatus(p: Principal, operationId: string) {
    const op = await this.o.authority.operations
      .get(operationId, {
        accessToken: await this.o.subjectToken(p),
      })
      .catch((error) => {
        throw error instanceof TaskAuthorityError && !error.retryable
          ? new AppError(
              "operation_not_found",
              error.status === 404 ? 404 : 403,
            )
          : error;
      });
    if (op.organizationId !== p.orgId)
      throw new AppError("operation_not_found", 404);
    const task = await this.repo.findByOperationId(operationId);
    const status =
      op.decision === "deny"
        ? "denied"
        : task?.result?.isError
          ? op.status === "rejected"
            ? "rejected"
            : "failed"
          : task?.status === "failed"
            ? "failed"
            : task?.status === "completed"
              ? "completed"
              : (op.outcomeStatus ??
                (op.approvalStatus === "approved"
                  ? "approved"
                  : "pending_approval"));
    return {
      ...op,
      status,
      authorityStatus: op.status,
      ...(task
        ? {
            taskId: task.taskId,
            stage: task.stage,
            statusMessage: task.statusMessage,
            result: task.result,
          }
        : {}),
      reviewUrl: op.approvalId
        ? this.o.reviewUrl(op.approvalId, op.organizationId)
        : undefined,
    };
  }

  async transportOutcome(
    t: Task,
  ): Promise<ProtectedOutcome<Record<string, unknown>>> {
    if (!t.operationId)
      throw new AppError("exception_note_required", 400, { taskId: t.taskId });
    const operation = await this.o.authority.operations.get(t.operationId);
    return {
      operation,
      decision:
        operation.decision ??
        (operation.approvalRequirement === "human"
          ? "approval_required"
          : "allow"),
      reasonCode: operation.reasonCode ?? "policy_evaluated",
      policyVersion: operation.policyVersion ?? null,
      ruleIds: operation.ruleIds ?? [],
      operationUrl: `/v1/operations/${encodeURIComponent(operation.id)}`,
      reviewUrl: operation.approvalId
        ? this.o.reviewUrl(operation.approvalId, t.orgId)
        : undefined,
      executed: t.status === "completed" && !t.result?.isError,
      result: {
        taskId: t.taskId,
        stage: t.stage,
        status: t.status,
        result: t.result,
      },
    };
  }

  private noteRequest(amountMinor: number, currency: string, key = NOTE_KEY) {
    return {
      [key]: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: `This refund needs a short exception note for the reviewer (${amountMinor} ${currency} minor units).`,
          requestedSchema: {
            type: "object",
            properties: {
              note: { type: "string", minLength: 5, maxLength: 500 },
            },
            required: ["note"],
          },
        },
      },
    };
  }

  private async insertOrRecover(t: Task, p: Principal, req: RefundInput) {
    try {
      const saved = await this.repo.insert(t);
      await this.repo.event(
        t.taskId,
        p.sub,
        "task_created",
        t.status === "input_required"
          ? "Waiting for the requester's exception note."
          : "Task created.",
      );
      return saved;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      return this.reuse(
        (await this.repo.findByKey(t.orgId, t.operationKey))!,
        p,
        req,
      );
    }
  }

  private reuse(existing: Task, p: Principal, req: RefundInput) {
    if (existing.ownerSub !== p.sub)
      throw new AppError("operation_exists_for_another_requester", 409);
    if (existing.request.currency !== req.currency)
      throw new AppError("operation_parameters_conflict", 409);
    // A cancelled or finished task is never revived by retrying the request.
    return existing;
  }

  /** Authorize through Task Authority, then persist: the handle is returned only after the task is durable. */
  private async authorizeAndInsert(t: Task, p: Principal): Promise<Task> {
    const who: Caller = {
      subjectToken: await this.o.subjectToken(p),
      orgId: p.orgId,
      agentId: p.agentId,
      actorType: p.actorType,
    };
    const a = await authorize(this.o, who, t).catch((e) => {
      throw this.mapAuthorityError(e);
    });
    t.delegationId = a.delegationId ?? null;
    t.operationId = a.operationId;
    t.operationDigest = a.operationDigest;
    t.payment = a.payment;
    if (a.decision === "deny" || a.decision === "step_up_required") {
      if (a.decision === "step_up_required")
        throw new AppError("insufficient_user_authentication", 401, {
          operation: a.operation,
          reasonCode: a.reasonCode,
        });
      t.status = "failed";
      t.stage = "finished";
      t.statusMessage = `Refund refused: ${a.reasonCode}.`;
      t.result = {
        content: [{ type: "text", text: t.statusMessage }],
        isError: true,
        structuredContent: { outcome: "denied", reasonCode: a.reasonCode },
      };
      t.error = {
        code: -32603,
        message: "operation_denied",
        data: { reasonCode: a.reasonCode },
      };
      return this.insertOrRecover(t, p, t.request as RefundInput);
    }
    t.status = "working";
    t.stage = "awaiting_return";
    t.inputRequests = null;
    t.statusMessage =
      a.requirement === "human"
        ? "Refund authorized for review. Waiting for warehouse return verification; a manager decision will then be required."
        : "Refund authorized under merchant policy. Waiting for warehouse return verification.";
    t.nextRunAt = new Date(this.now() + 365 * 86400_000);
    const orphan = await this.repo.orphanEvent(
      t.orgId,
      t.request.orderId,
      t.request.paymentId,
    );
    if (orphan) {
      t.receipt = orphan;
      t.stage = "awaiting_approval";
      t.statusMessage =
        "Return already verified. Evaluating refund authorization.";
      t.nextRunAt = new Date(this.now());
    }
    const saved = await this.insertOrRecover(t, p, t.request as RefundInput);
    if (orphan && saved.taskId === t.taskId)
      await this.repo.markEventApplied(orphan.eventId, t.taskId);
    return saved;
  }

  mapAuthorityError(e: unknown): AppError {
    if (e instanceof AppError) return e;
    if (e instanceof TaskAuthorityError)
      return new AppError(
        e.code === "network_error" || e.retryable
          ? "authority_unavailable"
          : "refund_not_authorized",
        e.retryable ? 503 : 403,
        {
          authorityCode: e.code,
          reason: e.details?.reason,
          correlationId: e.correlationId,
        },
      );
    if (e instanceof Error && e.message === "refund_not_eligible")
      return new AppError("refund_not_eligible", 400);
    return new AppError("dependency_unavailable", 503);
  }

  /** tasks/update: genuine client-answerable input only. Unknown or answered keys are ignored. */
  async answer(
    p: Principal,
    taskId: string,
    responses: Record<string, any>,
  ): Promise<void> {
    let t = await this.read(p, taskId);
    // Only currently outstanding keys count; answers to superseded or answered keys are ignored.
    const outstanding = Object.keys(t.inputRequests ?? {}).filter(
      (k) => responses[k] && !t.answeredInputs.includes(k),
    );
    const owner = outstanding.find(isOwnerKey);
    if (owner) return this.answerOwner(p, t, owner, responses[owner]);
    const key = outstanding.find(isNoteKey);
    if (t.status !== "input_required" || !key) return;
    const answer = responses[key];
    if (answer.action !== "accept") {
      await this.finish(
        t,
        "cancelled",
        null,
        "The requester declined to provide the exception note.",
      );
      return;
    }
    const note = z
      .string()
      .trim()
      .min(5)
      .max(500)
      .safeParse(answer.content?.note);
    if (!note.success) throw new AppError("invalid_input_response", 400);
    t = {
      ...t,
      request: { ...t.request, exceptionNote: note.data },
      answeredInputs: [...t.answeredInputs, key],
    };
    // Claim the transition with CAS so a duplicate update cannot authorize twice.
    try {
      t = await this.repo.save({
        ...t,
        inputRequests: null,
        status: "working",
        stage: "awaiting_return",
        // Short lease: if this process dies before authorization completes, tick() reopens the input.
        nextRunAt: new Date(this.now() + AUTHORIZE_LEASE_MS),
        statusMessage:
          "Exception note received. Authorizing the refund request.",
      });
    } catch (e) {
      if (e instanceof ConflictError) return; // a concurrent update already took this input
      throw e;
    }
    const saved = await this.authorizeInPlace(t, p);
    void saved;
  }

  private async authorizeInPlace(t: Task, p: Principal) {
    try {
      const who: Caller = {
        subjectToken: await this.o.subjectToken(p),
        orgId: p.orgId,
        agentId: p.agentId,
        actorType: p.actorType,
      };
      const a = await authorize(this.o, who, t);
      if (a.decision === "deny" || a.decision === "step_up_required")
        return this.finish(
          {
            ...t,
            delegationId: a.delegationId ?? null,
            operationId: a.operationId,
            operationDigest: a.operationDigest,
            payment: a.payment,
          },
          "completed",
          { outcome: a.decision, reasonCode: a.reasonCode },
          `Refund refused: ${a.reasonCode}.`,
          true,
        );
      const orphan = await this.repo.orphanEvent(
        t.orgId,
        t.request.orderId,
        t.request.paymentId,
      );
      const next: Task = {
        ...t,
        delegationId: a.delegationId ?? null,
        operationId: a.operationId,
        operationDigest: a.operationDigest,
        payment: a.payment,
        receipt: orphan,
        stage: orphan ? "awaiting_approval" : "awaiting_return",
        nextRunAt: new Date(orphan ? this.now() : this.now() + 365 * 86400_000),
        statusMessage: orphan
          ? "Return already verified. Evaluating refund authorization."
          : "Refund authorized for review. Waiting for warehouse return verification.",
      };
      const saved = await this.repo.save(next);
      if (orphan)
        await this.repo.markEventApplied(orphan.eventId, saved.taskId);
      await this.repo.event(
        t.taskId,
        p.sub,
        "authorized",
        "Scoped delegation and exact operation registered with Task Authority.",
      );
      return saved;
    } catch (e) {
      // The lease lapsed and tick() reopened the input: the late result must not overwrite it.
      if (e instanceof ConflictError) return null;
      const err = this.mapAuthorityError(e);
      await this.finish(
        (await this.repo.get(t.taskId)) ?? t,
        "completed",
        { outcome: err.code, ...err.data },
        `Refund was not authorized: ${err.code}.`,
        true,
      );
      return null;
    }
  }

  /**
   * URL elicitation answers only say whether the user went to the page. "accept" never means
   * approved: the decision is read back from Task Authority by the worker.
   */
  private async answerOwner(p: Principal, t: Task, key: string, answer: any) {
    const approvalId = (t.inputRequests?.[key] as any)?.params
      ?.elicitationId as string | undefined;
    if (t.status !== "input_required" || !approvalId) return;
    if (answer.action !== "accept") {
      await this.cancel(p, t.taskId);
      return;
    }
    try {
      await this.repo.save({
        ...t,
        status: "working",
        inputRequests: null,
        // Keyed by approval: a fresh approval after expiry asks the owner again, under a new key.
        answeredInputs: [...t.answeredInputs, ownerKey(approvalId)],
        nextRunAt: new Date(this.now()),
        statusMessage: "Waiting for you to finish approving in the browser.",
      });
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }

  /** tasks/cancel: cooperative. A claimed operation is never reported as reversed. */
  async cancel(p: Principal, taskId: string): Promise<Task> {
    const t = await this.read(p, taskId);
    if (
      t.status === "completed" ||
      t.status === "failed" ||
      t.status === "cancelled"
    )
      return t;
    if (t.operationId && ["dispatching", "reconciling"].includes(t.stage)) {
      await this.repo.event(
        t.taskId,
        p.sub,
        "cancel_requested",
        "Cancellation requested after dispatch began; the outcome is being reconciled.",
      );
      return this.repo.save({
        ...t,
        statusMessage:
          "Cancellation requested, but dispatch had already started. Reconciling the provider outcome.",
      });
    }
    if (t.operationId) {
      const r = await this.o.authority.operations.cancel(t.operationId, {
        reason: "task_cancelled",
      });
      if (!r.cancelled)
        return this.repo.save({
          ...t,
          stage: "dispatching",
          statusMessage:
            "Cancellation requested, but dispatch had already started. Reconciling the provider outcome.",
          nextRunAt: new Date(this.now()),
        });
    }
    return this.finish(
      t,
      "cancelled",
      null,
      "Cancelled by the requester before dispatch. No refund was sent.",
    );
  }

  // ---- worker -------------------------------------------------------------

  async runDue() {
    for (const t of await this.repo.due())
      await this.tick(t).catch((e) =>
        console.error(
          JSON.stringify({
            event: "tick_failed",
            taskId: t.taskId,
            type: e instanceof Error ? e.name : "unknown",
          }),
        ),
      );
  }

  async tick(task: Task): Promise<Task | null> {
    let t: Task;
    try {
      // The version is the lease: competing workers cannot hold the same version.
      t = await this.repo.save({
        ...task,
        nextRunAt: new Date(this.now() + 60_000),
      });
    } catch (e) {
      if (e instanceof ConflictError) return null;
      throw e;
    }
    try {
      if (t.stage === "awaiting_return" && !t.operationId)
        return await this.reopenInput(t);
      if (t.stage === "awaiting_approval") return await this.review(t);
      if (["ready", "dispatching", "reconciling"].includes(t.stage))
        return await this.execute(t);
      return t;
    } catch (e) {
      return this.retryLater(t, e);
    }
  }

  /**
   * A requester's answer was accepted but the process died before authority was registered.
   * Nothing was authorized and the user's token is gone, so ask again rather than strand the task.
   */
  private async reopenInput(t: Task): Promise<Task> {
    await this.repo.event(
      t.taskId,
      "worker",
      "authorization_interrupted",
      "Authorization did not complete; the exception note is requested again.",
    );
    return this.repo.save({
      ...t,
      status: "input_required",
      stage: "awaiting_input",
      // Keep the answered keys: the re-ask must use a key the client has never answered.
      inputRequests: this.noteRequest(
        t.request.amountMinor,
        t.request.currency,
        `${NOTE_KEY}:${t.answeredInputs.filter(isNoteKey).length + 1}`,
      ),
      nextRunAt: new Date(this.now() + 365 * 86400_000),
      statusMessage:
        "Authorization was interrupted. Please provide the exception note again.",
    });
  }

  private async review(t: Task): Promise<Task> {
    let op = await this.o.authority.operations.get(t.operationId!);
    // CIBA: the service owns the conversation with the provider; we only ask it to check.
    // The poll endpoint is a no-op for portal approvals, so no channel switch is needed here.
    if (op.approvalStatus === "pending" && op.approvalId) {
      const polled = await this.o.authority.approvals.poll(op.approvalId);
      if (polled.method === "ciba_rar")
        op = await this.o.authority.operations.get(t.operationId!);
    }
    if (op.status === "cancelled" || op.status === "rejected")
      return this.finish(
        t,
        "completed",
        {
          outcome:
            op.status === "rejected"
              ? "approval_rejected"
              : "operation_cancelled",
        },
        op.status === "rejected"
          ? "A reviewer rejected this refund. No refund was sent."
          : "Authority was withdrawn. No refund was sent.",
        true,
      );
    if (op.approvalRequirement === "none" || op.approvalStatus === "approved") {
      await this.repo.event(
        t.taskId,
        "worker",
        "ready",
        op.approvalRequirement === "none"
          ? "No human approval required by policy."
          : "Approval recorded by Task Authority.",
      );
      return this.repo.save({
        ...t,
        status: "working",
        inputRequests: null,
        stage: "ready",
        failures: 0,
        nextRunAt: new Date(this.now()),
        statusMessage: "Authorized. Preparing refund.",
      });
    }
    if (op.approvalStatus === "rejected")
      return this.finish(
        t,
        "completed",
        { outcome: "approval_rejected" },
        "A reviewer rejected this refund. No refund was sent.",
        true,
      );
    const ap =
      op.approvalStatus === "pending"
        ? { id: op.approvalId! }
        : await requestReview(this.o, t);
    if (op.approvalStatus !== "pending")
      await this.repo.event(
        t.taskId,
        "worker",
        "approval_requested",
        `A manager decision was requested: ${this.o.reviewUrl(ap!.id, t.orgId)}`,
      );
    const url = this.o.reviewUrl(ap!.id, t.orgId);
    // Policy lets the user who delegated to this agent approve it themselves: ask them in the
    // MCP client with a URL elicitation. The page, the passkey and the decision all live in
    // Task Authority, so REST and CLI callers reach the same approval through the same URL.
    if (
      op.ownerApproval &&
      this.o.ownerPrompt !== "status" &&
      !t.answeredInputs.includes(ownerKey(ap!.id))
    )
      return this.repo.save({
        ...t,
        status: "input_required",
        inputRequests: this.ownerRequest(ap!.id, url),
        failures: 0,
        nextRunAt: new Date(this.now() + WAIT_MS),
        statusMessage: `Waiting for you to approve this refund: ${url}`,
      });
    return this.repo.save({
      ...t,
      failures: 0,
      nextRunAt: new Date(this.now() + WAIT_MS),
      statusMessage: op.ownerApproval
        ? this.o.ownerPrompt === "status"
          ? `Waiting for you to approve this refund: ${url}`
          : `Waiting for you to finish approving this refund: ${url}`
        : `Waiting for an eligible reviewer to approve: ${url}`,
    });
  }

  private ownerRequest(approvalId: string, url: string) {
    return {
      [ownerKey(approvalId)]: {
        method: "elicitation/create",
        params: {
          mode: "url",
          elicitationId: approvalId,
          url,
          message:
            "Approve this refund with your passkey. Your agent continues only after you approve.",
        },
      },
    };
  }

  private async execute(t: Task): Promise<Task> {
    if (
      t.dispatchedAt &&
      this.now() - t.dispatchedAt.getTime() >= IDEMPOTENCY_WINDOW_GUARD_MS &&
      !t.claimId
    )
      return this.finish(
        t,
        "failed",
        null,
        "Outcome unknown beyond the provider idempotency window; manual reconciliation required.",
        false,
        { code: -32603, message: "manual_reconciliation_required" },
      );
    // Persist the marker BEFORE any side effect so a crash is recoverable.
    t = await this.repo.save({
      ...t,
      stage: "dispatching",
      attempts: t.attempts + 1,
      dispatchedAt: t.dispatchedAt ?? new Date(this.now()),
    });
    const r = await dispatch(this.o, t);
    if (r.kind === "released")
      return this.repo.save({
        ...t,
        stage: "ready",
        nextRunAt: new Date(this.now()),
        statusMessage:
          "Provider has no record of this refund; re-authorizing before dispatch.",
      });
    if (r.kind === "denied")
      return this.denied(t, r.claim.code, r.claim.reason, r.claim.retryable);
    return this.settle(t, r.refund);
  }

  private async settle(t: Task, refund: ProviderRefund): Promise<Task> {
    const base = { providerReference: refund.refundId };
    await this.repo.event(
      t.taskId,
      "executor",
      "provider_result",
      `Provider (${this.o.providerMode}) reported refund ${refund.refundId}: ${refund.status}.`,
    );
    if (refund.status === "pending")
      return this.repo.save({
        ...t,
        ...base,
        stage: "reconciling",
        nextRunAt: new Date(this.now() + 60_000),
        statusMessage: "Provider refund pending; reconciling.",
      });
    if (refund.status === "failed")
      return this.finish(
        { ...t, ...base },
        "completed",
        { outcome: "provider_failed", refundId: refund.refundId },
        "The provider reported the refund as failed.",
        true,
      );
    return this.finish(
      { ...t, ...base },
      "completed",
      {
        outcome: "refunded",
        refundId: refund.refundId,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
      },
      `Refund ${refund.refundId} succeeded (${this.o.providerMode}).`,
    );
  }

  private async denied(
    t: Task,
    code: string,
    reason: string,
    retryable: boolean,
  ): Promise<Task> {
    await this.repo.event(
      t.taskId,
      "executor",
      "claim_denied",
      `Task Authority refused dispatch: ${reason}.`,
    );
    if (
      [
        "approval_pending",
        "approval_required",
        "approval_expired",
        "approver_ineligible",
      ].includes(code)
    ) {
      // Ask Task Authority for a decision again: it returns the live one, or supersedes a stale/ineligible one.
      await requestReview(this.o, t);
      return this.repo.save({
        ...t,
        stage: "awaiting_approval",
        nextRunAt: new Date(this.now()),
        statusMessage:
          code === "approver_ineligible"
            ? "The approving reviewer is no longer eligible. A fresh decision is required."
            : "A fresh reviewer decision is required.",
      });
    }
    if (retryable || code === "authorization_unavailable")
      throw new AppError("authority_unavailable", 503);
    return this.finish(
      t,
      "completed",
      { outcome: code, reason },
      `Dispatch refused by Task Authority (${reason}). No refund was sent.`,
      true,
    );
  }

  private async retryLater(t: Task, e: unknown): Promise<Task> {
    const latest = (await this.repo.get(t.taskId)) ?? t;
    if (latest.status !== "working") return latest;
    const failures = latest.failures + 1;
    const unknownOutcome =
      e instanceof DispatchUncertain || latest.stage === "reconciling";
    if (failures >= MAX_FAILURES)
      return this.finish(
        { ...latest, failures },
        "failed",
        null,
        unknownOutcome
          ? "Dependency retries exhausted; the refund outcome is unknown. Verify it with the provider before any further action."
          : "Dependency retries exhausted before dispatch.",
        false,
        {
          code: -32603,
          message: unknownOutcome
            ? "manual_reconciliation_required"
            : "dependency_retry_limit",
        },
      );
    await this.repo.event(
      t.taskId,
      "worker",
      "retry",
      `Dependency unavailable (${e instanceof Error ? e.name : "error"}); will reconcile before retrying.`,
    );
    return this.repo.save({
      ...latest,
      failures,
      stage:
        e instanceof DispatchUncertain
          ? "reconciling"
          : latest.stage === "dispatching"
            ? "ready"
            : latest.stage,
      nextRunAt: new Date(this.now() + Math.min(900_000, 1000 * 2 ** failures)),
      statusMessage:
        "A dependency is unavailable. The worker will reconcile before retrying.",
    });
  }

  private async finish(
    t: Task,
    status: "completed" | "failed" | "cancelled",
    result: Record<string, unknown> | null,
    message: string,
    isError = false,
    error?: Record<string, unknown>,
  ): Promise<Task> {
    const op = t.operationId
      ? await this.o.authority.operations.get(t.operationId).catch(() => null)
      : null;
    // How it was authorized travels with the result: the model summarizes it for the user, and
    // without this it guesses (wrongly) that nobody had to approve.
    const authority = op
      ? {
          operationId: op.id,
          correlationId: op.correlationId,
          approval:
            op.approvalRequirement === "human"
              ? {
                  required: true,
                  approvalId: op.approvalId,
                  status: op.approvalStatus,
                  ownerMayApprove: op.ownerApproval === true,
                }
              : { required: false },
        }
      : undefined;
    const body = result
      ? {
          ...result,
          orderId: t.request.orderId,
          ...(t.request.exceptionNote
            ? { exceptionNote: t.request.exceptionNote }
            : {}),
          providerMode: this.o.providerMode,
          authority,
        }
      : null;
    const saved = await this.repo.save({
      ...t,
      status,
      stage: "finished" as Stage,
      statusMessage: message,
      inputRequests: null,
      nextRunAt: new Date(this.now() + 365 * 86400_000),
      result: body
        ? {
            content: [{ type: "text", text: message }],
            structuredContent: body,
            isError,
          }
        : null,
      error:
        status === "failed"
          ? {
              code: -32603,
              message: "execution_failed",
              data: { reason: error?.message ?? "unknown", ...authority },
            }
          : null,
    });
    await this.repo.event(t.taskId, "worker", status, message);
    // Per-task authority is single purpose: withdraw what is no longer needed (best effort).
    if (
      t.delegationId &&
      t.delegationId !== this.o.standingDelegations?.[t.orgId]
    )
      await this.o.authority.delegations
        .revoke(t.delegationId, { reason: "task_finished" })
        .catch(() => undefined);
    return saved;
  }

  /** Operator-only (demo mode): the same timeline without a requester principal. */
  async operatorView(taskId: string) {
    const t = await this.repo.get(taskId);
    if (!t) throw new AppError("task_not_found", 404);
    return {
      task: {
        taskId: t.taskId,
        status: t.status,
        stage: t.stage,
        statusMessage: t.statusMessage,
        operationId: t.operationId,
        delegationId: t.delegationId,
        request: t.request,
      },
      timeline: await this.timeline(
        { sub: t.ownerSub, orgId: t.orgId },
        taskId,
      ),
    };
  }

  /** Correlated timeline: application events interleaved with Task Authority's security decisions. */
  async timeline(p: Pick<Principal, "sub" | "orgId">, taskId: string) {
    const t = await this.read(p, taskId);
    const app = (await this.repo.events(t.taskId)).map((e) => ({
      at: e.at,
      layer: "customer app",
      actor: e.actor,
      event: e.event,
      detail: e.detail,
    }));
    const authority = t.operationId
      ? (
          await (this.o.auditor ?? this.o.authority).audit
            .list(t.operationId)
            .catch(() => [])
        ).map((e) => ({
          at: e.at,
          layer: "task authority",
          actor: e.actor.id,
          event: e.type,
          detail: `${e.decision}${e.reasonCode ? `: ${e.reasonCode}` : ""}`,
          correlationId: e.correlationId,
        }))
      : [];
    return [...app, ...authority].sort((a, b) => a.at.localeCompare(b.at));
  }
}
