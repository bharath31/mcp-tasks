import type { ErrorCode } from "@task-authority/contracts";
import type { ClaimDenied, ClaimReconcile } from "./types.js";

export class TaskAuthorityError extends Error {
  constructor(
    readonly code: ErrorCode | "network_error",
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly correlationId: string | null,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TaskAuthorityError";
  }
}

/** Thrown by customer code when a claim is not `authorized`. */
export class AuthorizationRequired extends Error {
  readonly code: string;
  constructor(readonly claim: ClaimDenied | ClaimReconcile) {
    super(`Authorization required: ${claim.code} (${claim.correlationId})`);
    this.name = "AuthorizationRequired";
    this.code = claim.code;
  }
}
