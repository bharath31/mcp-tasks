import { CLAIM_DENIAL_CODES, type ApiError } from "@task-authority/contracts";
import { AuthorizationRequired, TaskAuthorityError } from "./errors.js";
import { protect, type ProtectOptions } from "./protect.js";
import type { ClaimAuthorized } from "./types.js";
import type {
  ApprovalView,
  AuditEntry,
  ClaimResult,
  DelegationInput,
  DelegationView,
  OperationView,
  OutcomeReporter,
  OutcomeResponse,
  RegisterInput,
} from "./types.js";

export type RetryPolicy = {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};
export type TaskAuthorityOptions = {
  baseUrl: string;
  /** Backend credential provider (e.g. Auth0 client-credentials). Never run in a browser/agent. */
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
  retry?: Partial<RetryPolicy>;
  correlationId?: string;
  sleep?: (ms: number) => Promise<void>;
};

const TRANSIENT = new Set([
  "authorization_unavailable",
  "rate_limited",
  "internal_error",
]);
const uuid = () => crypto.randomUUID();

type CallOptions = {
  body?: unknown;
  subject?: { accessToken: string };
  idempotencyKey?: string;
  accessToken?: string;
};

export class TaskAuthority {
  readonly delegations;
  readonly operations;
  readonly approvals;
  readonly audit;
  readonly usage;
  readonly providerEvents;
  private readonly retry: RetryPolicy;

  constructor(private readonly o: TaskAuthorityOptions) {
    this.retry = { retries: 2, baseDelayMs: 150, maxDelayMs: 2000, ...o.retry };
    this.delegations = {
      create: (i: DelegationInput) =>
        this.call<DelegationView>("POST", "/v1/delegations", {
          subject: i.owner,
          idempotencyKey: i.idempotencyKey,
          body: {
            ownerType: i.ownerType,
            organizationId: i.owner.organizationId,
            agentId: i.agent.agentId,
            resource: i.resource,
            actions: i.actions,
            expiresAt: i.expiresAt,
            resourcePrefixes: i.resourcePrefixes,
            ceilings: i.ceilings,
            reason: i.reason,
          },
        }),
      get: (id: string) =>
        this.call<DelegationView>("GET", `/v1/delegations/${enc(id)}`),
      revoke: (
        id: string,
        p: { reason?: string; subject?: { accessToken: string } } = {},
      ) =>
        this.call<DelegationView>("POST", `/v1/delegations/${enc(id)}/revoke`, {
          subject: p.subject,
          body: { reason: p.reason },
        }),
    };
    this.operations = {
      register: (i: RegisterInput) => {
        const { initiator, idempotencyKey, approvalAssertion, ...rest } = i;
        return this.call<OperationView & { digest: string; id: string }>(
          "POST",
          "/v1/operations",
          {
            subject: initiator,
            idempotencyKey,
            body: {
              ...rest,
              ...(approvalAssertion === undefined ? {} : { approvalAssertion }),
            },
          },
        );
      },
      get: (id: string, p: { accessToken?: string } = {}) =>
        this.call<OperationView>("GET", `/v1/operations/${enc(id)}`, p).then(
          (operation) => ({
            ...operation,
            status: operation.lifecycleStatus ?? operation.status,
          }),
        ),
      cancel: (id: string, p: { reason?: string } = {}) =>
        this.call<{
          operation: OperationView;
          cancelled: boolean;
          inFlightOrUnknown: boolean;
        }>("POST", `/v1/operations/${enc(id)}/cancel`, {
          body: { reason: p.reason },
        }),
      /**
       * Call from the trusted executor immediately before a new side effect.
       * Policy refusals are returned as `{ decision: 'denied', code }` (never
       * thrown), so the caller can map them to a task state. Transport and
       * contract errors still throw `TaskAuthorityError`.
       */
      authorizeAndClaim: async (p: {
        operationId: string;
        operationDigest: string;
        executionKey: string;
        businessStateVersion?: string;
      }): Promise<ClaimResult> => {
        try {
          const res = await this.call<ClaimResult>(
            "POST",
            `/v1/operations/${enc(p.operationId)}/claims`,
            {
              body: {
                operationDigest: p.operationDigest,
                executionKey: p.executionKey,
                businessStateVersion: p.businessStateVersion,
              },
              // No fixed key: the service resolves repeat claims itself (recover or reconcile_required),
              // and a per-call key (reused only across retries of this call) covers lost responses.
            },
          );
          if (res.decision === "denied") return res;
          // Non-enumerable so the claim still serializes and compares as plain data.
          Object.defineProperty(res, "report", {
            enumerable: false,
            value: (
              providerStatus: Parameters<OutcomeReporter["report"]>[0],
              providerReference?: string,
            ) =>
              this.operations.reportOutcome({
                operationId: p.operationId,
                claimId: res.claimId,
                providerStatus,
                providerReference,
              }),
          });
          return res;
        } catch (e) {
          if (
            e instanceof TaskAuthorityError &&
            (CLAIM_DENIAL_CODES as readonly string[]).includes(e.code)
          )
            return {
              decision: "denied",
              code: e.code as never,
              reason: String(e.details?.reason ?? e.code),
              retryable: e.retryable,
              correlationId: e.correlationId ?? "",
              operationId: p.operationId,
              details: e.details,
            };
          throw e;
        }
      },
      reportOutcome: (p: {
        operationId: string;
        claimId: string;
        providerStatus:
          "succeeded" | "failed" | "pending" | "unknown" | "not_submitted";
        providerReference?: string;
        detail?: string;
      }) =>
        this.call<OutcomeResponse>(
          "POST",
          `/v1/operations/${enc(p.operationId)}/outcomes`,
          {
            body: {
              claimId: p.claimId,
              providerStatus: p.providerStatus,
              providerReference: p.providerReference,
              detail: p.detail,
            },
            idempotencyKey:
              `outcome:${p.claimId}:${p.providerStatus}:${p.providerReference ?? ""}`.slice(
                0,
                128,
              ),
          },
        ),
    };
    this.approvals = {
      /** Explicit opt-in escalation; ordinary approval requests never notify a named person. */
      escalate: (id: string, p: { reviewerSubject: string }) =>
        this.call<ApprovalView>(
          "POST",
          `/v1/approval-requests/${enc(id)}/escalate`,
          { body: p },
        ),
      list: (p: { accessToken?: string; status?: string } = {}) =>
        this.call<{ approvals: ApprovalView[] }>(
          "GET",
          `/v1/approval-requests?status=${enc(p.status ?? "pending")}`,
          { accessToken: p.accessToken },
        ),
      lease: (id: string, p: { accessToken?: string } = {}) =>
        this.call<ApprovalView>(
          "POST",
          `/v1/approval-requests/${enc(id)}/lease`,
          { accessToken: p.accessToken, body: {} },
        ),
      decide: (
        id: string,
        p: {
          accessToken: string;
          decision: "approve" | "reject";
          operationDigest: string;
        },
      ) =>
        this.call<ApprovalView>(
          "POST",
          `/v1/approval-requests/${enc(id)}/decisions`,
          {
            accessToken: p.accessToken,
            body: { decision: p.decision, operationDigest: p.operationDigest },
          },
        ),
      decideBatch: (p: {
        accessToken: string;
        decisions: Array<{
          approvalId: string;
          operationDigest: string;
          decision: "approve" | "reject";
        }>;
      }) =>
        this.call<{ approvals: ApprovalView[] }>(
          "POST",
          "/v1/approval-requests/decisions",
          { accessToken: p.accessToken, body: { decisions: p.decisions } },
        ),
      request: (p: {
        operationId: string;
        permission?: string;
        reviewerHint?: string;
      }) =>
        this.call<ApprovalView>(
          "POST",
          `/v1/operations/${enc(p.operationId)}/approval-requests`,
          {
            body: {
              permission: p.permission,
              reviewerHint: p.reviewerHint,
            },
          },
        ),
      /** CIBA: ask the service to check the provider for the reviewer's decision (idempotent). */
      poll: (id: string) =>
        this.call<
          ApprovalView & {
            polled: "pending" | "approved" | "rejected" | "expired" | "none";
          }
        >("POST", `/v1/approval-requests/${enc(id)}/ciba/poll`, { body: {} }),
      get: (id: string, p: { accessToken?: string } = {}) =>
        this.call<ApprovalView>("GET", `/v1/approval-requests/${enc(id)}`, {
          accessToken: p.accessToken,
        }),
    };
    this.audit = {
      list: async (operationId: string) =>
        (
          await this.call<{ events: AuditEntry[] }>(
            "GET",
            `/v1/operations/${enc(operationId)}/audit`,
          )
        ).events,
      /** Investigator query across a tenant (needs audit:read) or the caller's organization (FGA investigator). */
      query: (
        q: {
          correlationId?: string;
          operationId?: string;
          delegationId?: string;
          type?: string;
          reason?: string;
          limit?: number;
          after?: string | number;
        } = {},
      ) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(q))
          if (v !== undefined) qs.set(k, String(v));
        return this.call<{ events: AuditEntry[]; next: number | null }>(
          "GET",
          `/v1/audit${qs.size ? `?${qs}` : ""}`,
        );
      },
    };
    this.usage = {
      get: (day?: string) =>
        this.call<{
          tenantId: string;
          day: string;
          counters: Record<string, number>;
          quotas: Record<string, number>;
        }>("GET", `/v1/usage${day ? `?day=${day}` : ""}`),
    };
    this.providerEvents = {
      report: (event: {
        amountMinor?: number;
        currency?: string;
        organizationId: string;
        providerReference: string;
        claimId?: string;
        action: string;
        resource: string;
      }) =>
        this.call<{ matched: boolean; bypassDetected: boolean }>(
          "POST",
          "/v1/provider-events",
          { body: event },
        ),
    };
  }

  protect<T>(
    action: string,
    facts: () =>
      Promise<Omit<RegisterInput, "action">> | Omit<RegisterInput, "action">,
    execute: (claim: ClaimAuthorized, operation: OperationView) => Promise<T>,
    options: ProtectOptions<T> = {},
  ) {
    return protect(this, action, facts, execute, options);
  }

  /** Same client with every request carrying the given correlation id. */
  withCorrelationId(correlationId: string) {
    return new TaskAuthority({ ...this.o, correlationId });
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    c: CallOptions = {},
  ): Promise<T> {
    const idempotencyKey =
      method === "POST" ? (c.idempotencyKey ?? `sdk:${uuid()}`) : undefined;
    let attempt = 0;
    for (;;) {
      try {
        return await this.once<T>(method, path, c, idempotencyKey);
      } catch (e) {
        const transient =
          e instanceof TaskAuthorityError &&
          (e.code === "network_error" || TRANSIENT.has(e.code));
        if (!transient || attempt >= this.retry.retries) throw e;
        const hinted =
          e instanceof TaskAuthorityError
            ? Number(e.details?.retryAfterSec)
            : NaN;
        const delay =
          Math.min(
            this.retry.maxDelayMs,
            Number.isFinite(hinted)
              ? hinted * 1000
              : this.retry.baseDelayMs * 2 ** attempt,
          ) *
          (0.5 + Math.random() / 2);
        attempt++;
        await (this.o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
          delay,
        );
      }
    }
  }

  private async once<T>(
    method: string,
    path: string,
    c: CallOptions,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${c.accessToken ?? (await this.o.getAccessToken())}`,
      accept: "application/json",
    };
    if (c.body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    if (this.o.correlationId)
      headers["x-correlation-id"] = this.o.correlationId;
    if (c.subject) headers["x-task-authority-subject"] = c.subject.accessToken;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(
        `${this.o.baseUrl.replace(/\/$/, "")}${path}`,
        {
          method,
          headers,
          body: c.body === undefined ? undefined : JSON.stringify(c.body),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new TaskAuthorityError(
        "network_error",
        "Task Authority was unreachable.",
        0,
        true,
        this.o.correlationId ?? null,
      );
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.ok) return json as T;
    const err = json as Partial<ApiError> | undefined;
    if (!err?.code)
      throw new TaskAuthorityError(
        "internal_error",
        `Unexpected ${res.status} from Task Authority.`,
        res.status,
        res.status >= 500,
        res.headers.get("x-correlation-id"),
      );
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new TaskAuthorityError(
      err.code,
      err.message ?? err.code,
      res.status,
      Boolean(err.retryable),
      err.correlationId ?? res.headers.get("x-correlation-id"),
      {
        ...err.details,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { retryAfterSec: retryAfter }
          : {}),
      },
    );
  }
}

const enc = encodeURIComponent;
export { AuthorizationRequired };
