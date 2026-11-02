// The protected refund workflow. The customer owns business validation, policy
// and the provider call; Task Authority (via the SDK) owns who may delegate,
// who may approve, and whether this exact operation is still authorized.
import {
  verifiedAgent,
  verifiedSubject,
  type ClaimAuthorized,
  type ClaimReconcile,
} from "@task-authority/sdk";
import { mintDispatchGrant, type ProviderRefund } from "./payments.js";
import { isEligible } from "./policy.js";
import { refundArguments, refundCommand, stateVersion } from "./refund.js";
import type { Task } from "./repository.js";
import {
  DispatchUncertain,
  type Caller,
  type Deps,
  type Dispatch,
} from "./types.js";

/** 1. Authenticated request: validate business facts, then scope authority to this exact refund. */
export async function authorize(d: Deps, who: Caller, t: Task) {
  const payment = await d.payments.inspect(t.orgId, t.request.paymentId);
  const facts = { amountMinor: t.request.amountMinor, payment };
  if (!isEligible(facts)) throw new Error("refund_not_eligible");
  const owner = verifiedSubject({
    accessToken: who.subjectToken,
    organizationId: who.orgId,
  });
  const delegationId =
    who.actorType === "human"
      ? undefined
      : (d.standingDelegations?.[t.orgId] ??
        (
          await d.authority.delegations.create({
            owner,
            agent: verifiedAgent(who.agentId),
            ownerType: "user",
            resource: `merchant:${t.orgId}/refunds`,
            actions: ["refund:create"],
            expiresAt: new Date(d.now() + 48 * 3600_000).toISOString(),
          })
        ).id);
  const guarded = await d.authority.protect(
    "refund:create",
    () => ({
      delegationId,
      operationKey: t.operationKey,
      taskId: t.taskId,
      resource: `payment:${t.request.paymentId}`,
      initiator: owner,
      arguments: refundArguments(t, payment),
      businessStateVersion: stateVersion(payment),
      organizationId: t.orgId,
      resourceServer: d.resourceServer ?? "https://refund-desk.example/api",
      facts: {
        paymentAmountMinor: payment.amountMinor,
        refundedMinor: payment.refundedMinor,
        reason: t.request.reason,
        returnRequired: true,
      },
    }),
    async () => {
      throw new Error("warehouse_return_required");
    },
    {
      prepareOnly: true,
      reviewUrl: (id) =>
        `/review.html?approval=${encodeURIComponent(id)}&org=${encodeURIComponent(t.orgId)}`,
    },
  );
  const op = guarded.operation;
  return {
    delegationId,
    operationId: op.id,
    operationDigest: op.digest,
    payment,
    requirement: op.approvalRequirement,
    decision: guarded.decision,
    reasonCode: guarded.reasonCode,
    operation: op,
  };
}

/** 2. Return verified: ask for a human decision only if the service says one is needed. */
export async function requestReview(d: Deps, t: Task) {
  const op = await d.authority.operations.get(t.operationId!);
  // authorize() only prepared the operation; the reviewer is woken now that the return is verified.
  // The service returns the live approval, or supersedes one whose approver lost eligibility.
  if (op.decision !== "approval_required" || op.approvalRequirement !== "human")
    return null;
  return d.authority.approvals.request({ operationId: op.id });
}

/** 3. Trusted executor, immediately before the side effect. No authorized claim, no provider call. */
export async function dispatch(d: Deps, t: Task): Promise<Dispatch> {
  const ref = {
    operationId: t.operationId!,
    operationDigest: t.operationDigest!,
    executionKey: t.operationKey,
  };
  const op = await d.authority.operations.get(ref.operationId);
  const run = async (
    claim: ClaimAuthorized | ClaimReconcile,
  ): Promise<Dispatch> => {
    let refund: ProviderRefund | null;
    try {
      // After a restart or lost response, ask the provider by key; never blindly replay.
      refund =
        claim.decision === "reconcile_required"
          ? await d.payments.lookup(refundCommand(t))
          : await d.payments.refund(
              refundCommand(t),
              mintDispatchGrant(claim.claimId, t.operationKey),
            );
      if (refund) await claim.report(refund.status, refund.refundId);
    } catch (e) {
      await claim.report("unknown").catch(() => undefined);
      throw new DispatchUncertain(
        e instanceof Error ? e.message : "provider_error",
      );
    }
    if (!refund)
      return (await claim.report("not_submitted"), { kind: "released" });
    return { kind: "outcome", refund };
  };
  const result = await d.authority.protect(
    "refund:create",
    () => {
      throw new Error("registered_operation_required");
    },
    run,
    {
      operation: op,
      executor: d.executor,
      executionKey: ref.executionKey,
      businessStateVersion: stateVersion(t.payment!),
      reconcile: run,
    },
  );
  if (result.executed) return result.result!;
  return {
    kind: "denied",
    claim:
      result.claim?.decision === "denied"
        ? result.claim
        : {
            decision: "denied",
            code:
              result.decision === "approval_required"
                ? "approval_required"
                : "not_authorized",
            reason: result.reasonCode,
            retryable: false,
            correlationId: op.correlationId,
            operationId: op.id,
          },
  };
}
