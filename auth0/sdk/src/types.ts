import type {
  ApprovalView,
  AuditEntry,
  ClaimResponse,
  CreateDelegation,
  DelegationView,
  ErrorCode,
  OperationView,
  OutcomeResponse,
  RegisterOperation,
} from "@task-authority/contracts";

export type {
  ApprovalView,
  AuditEntry,
  ClaimResponse,
  DelegationView,
  OperationView,
  OutcomeResponse,
};

declare const brand: unique symbol;

/**
 * A human whose identity was verified by the calling application's own
 * authentication (e.g. an Auth0 access token for the Task Authority audience).
 * There is deliberately no way to build one from a bare user id: the service
 * re-verifies the token, and nothing here is accepted from tool arguments.
 */
export type VerifiedSubject = {
  readonly [brand]: "subject";
  readonly accessToken: string;
  readonly organizationId: string;
};
/** The calling agent/workload, derived from trusted authentication context. */
export type VerifiedAgent = {
  readonly [brand]: "agent";
  readonly agentId: string;
};

export function verifiedSubject(p: {
  accessToken: string;
  organizationId: string;
}): VerifiedSubject {
  return {
    accessToken: p.accessToken,
    organizationId: p.organizationId,
  } as VerifiedSubject;
}
export function verifiedAgent(agentId: string): VerifiedAgent {
  return { agentId } as VerifiedAgent;
}

export type DelegationInput = {
  owner: VerifiedSubject;
  agent: VerifiedAgent;
  ownerType: CreateDelegation["ownerType"];
  resource: string;
  actions: string[];
  expiresAt: string;
  resourcePrefixes?: string[];
  ceilings?: Record<string, number>;
  reason?: string;
  idempotencyKey?: string;
};

export type RegisterInput = Omit<RegisterOperation, "approvalAssertion"> & {
  /** Optional raise-only assertion; the service always evaluates its active policy. */
  approvalAssertion?: RegisterOperation["approvalAssertion"];
  /** Verified initiating user, forwarded so the service can enforce separation of duties. */
  initiator?: VerifiedSubject;
  idempotencyKey?: string;
};

/** Reports the customer-attested provider outcome for this claim (unverified evidence, never authority). */
export type OutcomeReporter = {
  report(
    providerStatus:
      "succeeded" | "failed" | "pending" | "unknown" | "not_submitted",
    providerReference?: string,
  ): Promise<OutcomeResponse>;
};
export type ClaimAuthorized = Extract<
  ClaimResponse,
  { decision: "authorized" }
> &
  OutcomeReporter;
export type ClaimReconcile = Extract<
  ClaimResponse,
  { decision: "reconcile_required" }
> &
  OutcomeReporter;
export type ClaimDenied = {
  decision: "denied";
  code: ErrorCode;
  reason: string;
  retryable: boolean;
  correlationId: string;
  operationId: string;
  details?: Record<string, unknown>;
};
export type ClaimResult = ClaimAuthorized | ClaimReconcile | ClaimDenied;
