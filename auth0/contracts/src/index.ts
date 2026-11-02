// Prototype contract for the proposed "Auth0 Task Authority" service.
// These are NOT existing Auth0 public APIs. Schemas and types only.
import { z } from "zod";

export const CONTRACT_VERSION = "2026-10-15.v2";
export const CANONICAL_VERSION = 1;

export const ERROR_CODES = [
  "invalid_request",
  "invalid_identity",
  "invalid_tenant",
  "not_authorized",
  "not_found",
  "delegation_not_found",
  "delegation_expired",
  "delegation_revoked",
  "operation_expired",
  "operation_cancelled",
  "approval_required",
  "approval_pending",
  "approval_rejected",
  "approval_expired",
  "approver_ineligible",
  "operation_conflict",
  "operation_changed",
  "policy_denied",
  "budget_exhausted",
  "step_up_required",
  "lease_conflict",
  "authorization_unavailable",
  "claim_conflict",
  "reconcile_required",
  "provider_outcome_unknown",
  "quota_exceeded",
  "rate_limited",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ApiError = {
  code: ErrorCode;
  message: string;
  correlationId: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

/** Codes that mean "the claim was refused for an authorization reason". */
export const CLAIM_DENIAL_CODES: readonly ErrorCode[] = [
  "not_authorized",
  "delegation_expired",
  "delegation_revoked",
  "operation_expired",
  "operation_cancelled",
  "approval_required",
  "approval_pending",
  "approval_rejected",
  "approval_expired",
  "approver_ineligible",
  "operation_changed",
  "claim_conflict",
  "reconcile_required",
  "authorization_unavailable",
];

export const EVENT_TYPES = [
  "delegation.created",
  "delegation.revoked",
  "operation.registered",
  "operation.cancelled",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  "authorization.allowed",
  "authorization.denied",
  "claim.created",
  "claim.recovered",
  "claim.reconciliation_required",
  "outcome.reported",
  "policy.published",
  "policy.activated",
  "policy.shadow_evaluated",
  "policy.shadowed",
  "approval.leased",
  "bypass.detected",
  "notification.digest",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9:_\-./@]+$/);
const isoTime = z.iso.datetime({ offset: true });
export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string().max(2000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(json).max(100),
    z.record(z.string().max(100), json),
  ]),
);

export const ownerTypeSchema = z.enum(["user", "organization"]);
export type OwnerType = z.infer<typeof ownerTypeSchema>;

export const createDelegationSchema = z
  .object({
    ownerType: ownerTypeSchema,
    organizationId: id,
    agentId: id,
    resource: id,
    actions: z.array(id).min(1).max(20),
    resourcePrefixes: z.array(id).max(20).optional(),
    /** Hard ceilings on numeric operation arguments, e.g. { amountMinor: 20000 }. */
    ceilings: z.record(z.string().max(60), z.number().int().safe()).optional(),
    expiresAt: isoTime,
    reason: z.string().max(500).optional(),
  })
  .strict();
export type CreateDelegation = z.infer<typeof createDelegationSchema>;

export const registerOperationSchema = z
  .object({
    delegationId: id.optional(),
    organizationId: id.optional(),
    resourceServer: z.string().min(1).max(500).optional(),
    facts: z.record(z.string().max(100), json).optional(),
    operationKey: id,
    taskId: id.optional(),
    action: id,
    resource: id,
    arguments: z.record(z.string().max(100), json),
    /** The customer's own business-policy assertion. It can only raise the requirement. */
    approvalAssertion: z.enum(["none", "human"]).optional(),
    /** Opaque customer business-state version (e.g. payment snapshot). Bound into the digest. */
    businessStateVersion: z.string().max(200).optional(),
    expiresAt: isoTime.optional(),
  })
  .strict();
export type RegisterOperation = z.infer<typeof registerOperationSchema>;

export const requestApprovalSchema = z
  .object({
    permission: id.optional(),
    /** Display hint only. The service never treats it as eligibility. */
    reviewerHint: z.string().max(254).optional(),
  })
  .strict();
export type RequestApproval = z.infer<typeof requestApprovalSchema>;

export const decisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    operationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    /** Optional reviewer note, recorded in the audit trail. It never changes the decision. */
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type Decision = z.infer<typeof decisionSchema>;

export const claimRequestSchema = z
  .object({
    operationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    executionKey: id,
    businessStateVersion: z.string().max(200).optional(),
  })
  .strict();
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const PROVIDER_STATUSES = [
  "succeeded",
  "failed",
  "pending",
  "unknown",
  "not_submitted",
] as const;
export const outcomeSchema = z
  .object({
    claimId: id,
    providerStatus: z.enum(PROVIDER_STATUSES),
    providerReference: id.optional(),
    detail: z.string().max(300).optional(),
  })
  .strict();
export type OutcomeReport = z.infer<typeof outcomeSchema>;

export const cancelOperationSchema = z
  .object({ reason: z.string().max(300).optional() })
  .strict();
export const revokeDelegationSchema = z
  .object({ reason: z.string().max(300).optional() })
  .strict();

export type DelegationView = {
  id: string;
  tenantId: string;
  organizationId: string;
  ownerType: OwnerType;
  actorId: string;
  agentId: string;
  resource: string;
  actions: string[];
  ceilings: Record<string, number>;
  status: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  correlationId: string;
  inFlightOperations?: string[];
};

export type ApprovalRequirement = "none" | "human";
export type OperationStatus =
  "registered" | "claimed" | "settled" | "cancelled" | "rejected";

export type OperationView = {
  id: string;
  tenantId: string;
  organizationId: string;
  delegationId: string | null;
  decision?: PolicyDecision;
  reasonCode?: string;
  ruleIds?: string[];
  policyVersion?: string | null;
  stepUp?: { acr: string; max_age: number };
  tier?: string | null;
  assurance?: Record<string, unknown> | null;
  actor?: PolicyActor;
  facts?: Record<string, Json>;
  resourceServer?: string;
  outcomeStatus?:
    | "pending_approval"
    | "step_up_required"
    | "approved"
    | "rejected"
    | "completed"
    | "failed"
    | "denied";
  operationKey: string;
  taskId: string | null;
  action: string;
  resource: string;
  /** The exact protected arguments the digest (and so any approval) covers. */
  arguments?: Record<string, Json>;
  canonicalVersion: number;
  digest: string;
  approvalRequirement: ApprovalRequirement;
  status: OperationStatus;
  lifecycleStatus?: OperationStatus;
  businessStateVersion: string | null;
  expiresAt: string;
  correlationId: string;
  approvalId: string | null;
  approvalStatus: ApprovalStatus | null;
  claim: { id: string; status: ClaimStatus } | null;
  /** True when policy lets the delegating user approve this operation themselves. */
  ownerApproval?: boolean;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalView = {
  id: string;
  operationId: string;
  operationDigest: string;
  status: ApprovalStatus;
  permission: string;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  method: "portal_stepup" | "ciba_rar";
  correlationId: string;
  tier?: string | null;
  assurance?: Record<string, unknown> | null;
  lease?: { reviewerId: string; expiresAt: string } | null;
  /** How the signed-in caller may decide this approval, if at all. */
  viewerRole?: "reviewer" | "owner" | null;
  /** Present only so the reviewer UI can show the exact operation. */
  operation?: {
    action: string;
    resource: string;
    arguments: Record<string, Json>;
    organizationId: string;
  };
};

export type ClaimStatus =
  "claimed" | "pending" | "unknown" | "succeeded" | "failed" | "released";
export type ClaimResponse =
  | {
      decision: "authorized";
      claimId: string;
      operationId: string;
      expiresAt: string;
      recovered: boolean;
      correlationId: string;
    }
  | {
      decision: "reconcile_required";
      claimId: string;
      operationId: string;
      code: "reconcile_required";
      reason: string;
      correlationId: string;
    };

export type OutcomeResponse = {
  operationId: string;
  claimId: string;
  claimStatus: ClaimStatus;
  operationStatus: OperationStatus;
  /** Always true: the service never verifies provider state. */
  unverifiedCustomerAttestation: true;
  correlationId: string;
};

export type AuditEntry = {
  id: string;
  type: EventType;
  at: string;
  tenantId: string;
  organizationId: string;
  delegationId: string | null;
  operationId: string | null;
  approvalId: string | null;
  claimId: string | null;
  correlationId: string;
  actor: { kind: "user" | "service" | "system"; id: string };
  decision: "allow" | "deny" | "info";
  reasonCode: string | null;
  evaluation: Record<string, unknown>;
};

export type PolicyDecision =
  "allow" | "step_up_required" | "approval_required" | "deny";
export type PolicyActor = {
  type: "human" | "agent" | "service";
  id: string;
  act?: Record<string, unknown> | null;
};
export const batchDecisionSchema = z
  .object({
    decisions: z
      .array(decisionSchema.extend({ approvalId: id }))
      .min(1)
      .max(5)
      .refine(
        (items) =>
          new Set(items.map((i) => i.approvalId)).size === items.length,
        "Duplicate approval id",
      ),
  })
  .strict();
export const leaseApprovalSchema = z
  .object({ leaseSec: z.number().int().min(15).max(300).optional() })
  .strict();
export const escalationSchema = z
  .object({
    reviewerSubject: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9:_\-./@|]+$/),
  })
  .strict();
export const reconciliationSchema = z
  .object({
    amountMinor: z.number().int().safe().nonnegative().optional(),
    currency: z.string().min(3).max(3).optional(),
    organizationId: id,
    providerReference: id,
    claimId: id.optional(),
    action: id,
    resource: id,
  })
  .strict();
