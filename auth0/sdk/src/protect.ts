import type { TaskAuthority } from "./client.js";
import type {
  ClaimAuthorized,
  ClaimDenied,
  ClaimReconcile,
  OperationView,
  RegisterInput,
} from "./types.js";

export type ProtectedOutcome<T = unknown> = {
  decision: "allow" | "approval_required" | "step_up_required" | "deny";
  reasonCode: string;
  policyVersion: string | null;
  ruleIds: string[];
  operation: OperationView;
  operationUrl: string;
  reviewUrl?: string;
  executed: boolean;
  result?: T;
  claim?: ClaimAuthorized | ClaimReconcile | ClaimDenied;
};
export type ProtectOptions<T = unknown> = {
  /** Read-only provider reconciliation is separate from the mutation callback. */
  reconcile?: (claim: ClaimReconcile, operation: OperationView) => Promise<T>;
  /** Resume a previously registered, durable operation; facts are never reinterpreted. */
  operation?: OperationView;
  /** Preparation may precede business prerequisites such as a warehouse return. */
  prepareOnly?: boolean;
  /** Recheck/supersede a stale reviewer decision after a claim refusal. This can only raise the requirement. */
  refreshApproval?: boolean;
  executor?: TaskAuthority;
  executionKey?: string;
  businessStateVersion?: string;
  operationUrl?: (id: string) => string;
  reviewUrl?: (id: string, operation: OperationView) => string;
};

/** All transports call this guard. Only a successful claim can reach execute. */
export async function protect<T>(
  authority: TaskAuthority,
  action: string,
  facts: () =>
    Promise<Omit<RegisterInput, "action">> | Omit<RegisterInput, "action">,
  execute: (claim: ClaimAuthorized, operation: OperationView) => Promise<T>,
  options: ProtectOptions<T> = {},
): Promise<ProtectedOutcome<T>> {
  const operation =
    options.operation ??
    (await authority.operations.register({ ...(await facts()), action }));
  if (operation.action !== action) throw new Error("protected_action_mismatch");
  const base = {
    operation,
    operationUrl:
      options.operationUrl?.(operation.id) ??
      `/v1/operations/${encodeURIComponent(operation.id)}`,
    reasonCode: operation.reasonCode ?? "policy_evaluated",
    policyVersion: operation.policyVersion ?? null,
    ruleIds: operation.ruleIds ?? [],
    executed: false,
  };
  if (
    operation.decision === "deny" ||
    operation.status === "cancelled" ||
    operation.status === "rejected"
  )
    return {
      ...base,
      decision: "deny",
      reasonCode: operation.reasonCode ?? operation.status,
    };
  if (operation.decision === "step_up_required")
    return { ...base, decision: "step_up_required" };
  const needsApproval =
    operation.approvalRequirement === "human" &&
    (operation.approvalStatus !== "approved" || options.refreshApproval);
  // Preparing must not wake a reviewer: the approval is requested when the business
  // prerequisites hold and protect runs again without prepareOnly.
  if (options.prepareOnly)
    return {
      ...base,
      decision: needsApproval ? "approval_required" : "allow",
    };
  if (needsApproval) {
    const approval = await authority.approvals.request({
      operationId: operation.id,
    });
    return {
      ...base,
      operation: {
        ...operation,
        approvalId: approval.id,
        approvalStatus: approval.status,
      },
      decision: "approval_required",
      reviewUrl:
        options.reviewUrl?.(approval.id, operation) ??
        `/review.html?approval=${encodeURIComponent(approval.id)}`,
    };
  }
  const claim = await (
    options.executor ?? authority
  ).operations.authorizeAndClaim({
    operationId: operation.id,
    operationDigest: operation.digest,
    executionKey: options.executionKey ?? operation.operationKey,
    businessStateVersion:
      options.businessStateVersion ??
      operation.businessStateVersion ??
      undefined,
  });
  if (claim.decision === "denied")
    return {
      ...base,
      claim,
      decision: [
        "approval_pending",
        "approval_required",
        "approval_expired",
        "approver_ineligible",
      ].includes(claim.code)
        ? "approval_required"
        : "deny",
      reasonCode: claim.code,
    };
  if (claim.decision === "reconcile_required") {
    if (!options.reconcile)
      return {
        ...base,
        claim,
        decision: "allow",
        reasonCode: "reconcile_required",
      };
    return {
      ...base,
      claim,
      decision: "allow",
      executed: true,
      result: await options.reconcile(claim, operation),
    };
  }
  return {
    ...base,
    claim,
    decision: "allow",
    executed: true,
    result: await execute(claim, operation),
  };
}

export function stepUpChallenge(
  operation: Pick<OperationView, "stepUp" | "assurance">,
) {
  const assurance = operation.stepUp ?? operation.assurance;
  const quoted = (value: unknown) => String(value).replace(/["\\\r\n]/g, "");
  return `Bearer error="insufficient_user_authentication", acr_values="${quoted(assurance?.acr ?? "mfa")}", max_age="${quoted(assurance?.max_age ?? 300)}"`;
}

export function renderRest<T>(outcome: ProtectedOutcome<T>): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  let status = outcome.executed ? 201 : 202;
  if (outcome.decision === "deny") status = 403;
  else if (outcome.decision === "step_up_required") {
    status = 401;
    headers["www-authenticate"] = stepUpChallenge(outcome.operation);
  } else if (status === 202) headers.location = outcome.operationUrl;
  return new Response(JSON.stringify(outcome), { status, headers });
}

/** CLI exit code for an operation's public outcome status: 1 refused, 2 needs re-authentication, else 0. */
export const outcomeExitCode = (status: OperationView["outcomeStatus"]) =>
  status === "denied" || status === "rejected" || status === "failed"
    ? 1
    : status === "step_up_required"
      ? 2
      : 0;
export const renderCli = <T>(outcome: ProtectedOutcome<T>) => ({
  exitCode:
    outcome.decision === "deny"
      ? 1
      : outcome.decision === "step_up_required"
        ? 2
        : 0,
  output: JSON.stringify(outcome),
  waitUrl:
    outcome.decision === "approval_required" || !outcome.executed
      ? outcome.operationUrl
      : undefined,
});
/** Key prefix of the URL elicitation that asks the agent's owner to approve on the hosted page. */
export const OWNER_APPROVAL_INPUT = "owner_approval";
/**
 * One key per approval. MCP Tasks forbids reusing an input-request key for a later request,
 * so a fresh approval (after the last one expired) is a new key that clients will show again.
 */
export const ownerApprovalInputKey = (approvalId: string) =>
  `${OWNER_APPROVAL_INPUT}:${approvalId}`;
export type RenderMcpOptions = {
  /**
   * How to ask the owner to approve their agent's operation. "elicitation" (default) asks in the
   * MCP client with a URL elicitation. "status" leaves the task working with the link in
   * statusMessage, for headless hosts that cancel any task asking for input (Claude Code does in
   * `claude -p`, Agent SDK and GitHub Actions runs).
   */
  ownerPrompt?: "elicitation" | "status";
};
export const renderMcp = <T>(
  outcome: ProtectedOutcome<T>,
  options: RenderMcpOptions = {},
) => {
  // The owner is the user in the MCP client, so ask them there (URL-mode elicitation). The
  // decision itself is made and verified on the approval page, never by the elicitation answer.
  const ownerWaits =
    outcome.decision === "approval_required" &&
    outcome.operation.ownerApproval === true &&
    Boolean(outcome.reviewUrl) &&
    Boolean(outcome.operation.approvalId);
  const askOwner = ownerWaits && options.ownerPrompt !== "status";
  return {
    status:
      outcome.decision === "deny"
        ? "failed"
        : outcome.executed
          ? "completed"
          : askOwner
            ? "input_required"
            : "working",
    statusMessage: ownerWaits
      ? `Waiting for you to approve: ${outcome.reviewUrl}`
      : outcome.reviewUrl
        ? `Waiting for approval: ${outcome.reviewUrl}`
        : outcome.reasonCode,
    ...(askOwner
      ? {
          inputRequests: {
            [ownerApprovalInputKey(outcome.operation.approvalId!)]: {
              method: "elicitation/create",
              params: {
                mode: "url",
                elicitationId: outcome.operation.approvalId!,
                url: outcome.reviewUrl!,
                message:
                  "Approve this operation with your passkey. Your agent continues only after you approve.",
              },
            },
          },
        }
      : {}),
    ...(outcome.decision === "step_up_required"
      ? {
          authorizationChallenge: {
            error: "insufficient_user_authentication",
            acr_values: outcome.operation.stepUp?.acr ?? "mfa",
            max_age: outcome.operation.stepUp?.max_age ?? 300,
          },
        }
      : {}),
    authority: {
      decision: outcome.decision,
      reasonCode: outcome.reasonCode,
      policyVersion: outcome.policyVersion,
      ruleIds: outcome.ruleIds,
    },
  };
};
