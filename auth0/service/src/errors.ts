import type { ErrorCode } from "@task-authority/contracts";

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_identity: 401,
  invalid_tenant: 403,
  not_authorized: 403,
  not_found: 404,
  delegation_not_found: 404,
  delegation_expired: 403,
  delegation_revoked: 403,
  operation_expired: 403,
  operation_cancelled: 409,
  approval_required: 409,
  approval_pending: 409,
  approval_rejected: 403,
  approval_expired: 403,
  approver_ineligible: 403,
  operation_conflict: 409,
  operation_changed: 409,
  authorization_unavailable: 503,
  claim_conflict: 409,
  reconcile_required: 409,
  provider_outcome_unknown: 409,
  quota_exceeded: 429,
  rate_limited: 429,
  policy_denied: 403,
  budget_exhausted: 409,
  step_up_required: 401,
  lease_conflict: 409,
  internal_error: 500,
};
const RETRYABLE = new Set<ErrorCode>([
  "authorization_unavailable",
  "rate_limited",
  "approval_pending",
  "internal_error",
]);

export class ServiceError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCode,
    message = code.replaceAll("_", " "),
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = STATUS[code];
    this.retryable = RETRYABLE.has(code);
  }
}
