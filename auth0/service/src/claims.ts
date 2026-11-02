import type {
  ClaimRequest,
  ClaimResponse,
  OutcomeReport,
  OutcomeResponse,
} from "@task-authority/contracts";
import { audit } from "./audit.js";
import { requirePermission } from "./authn.js";
import {
  actorOf,
  delegationStatus,
  notFound,
  org,
  requireTrustedBackend,
  type Ctx,
} from "./context.js";
import { loadDelegation } from "./delegations.js";
import { ServiceError } from "./errors.js";
import { fgaCheck } from "./fga.js";
import { ownerMayApprove } from "./approvals.js";
import { loadOperation } from "./operations.js";
import {
  budgetAvailability,
  consumeBudgets,
  applyRequirementFloor,
  evaluatePolicy,
  loadPolicy,
  releaseBudgetReservations,
} from "./policies.js";
import {
  iso,
  type ApprovalRow,
  type ClaimRow,
  type Db,
  type DelegationRow,
  type OperationRow,
} from "./store.js";
import { bump } from "./usage.js";

const LIVE = ["claimed", "pending", "unknown", "succeeded", "failed"] as const;

/**
 * Atomic authorize-and-claim. Lock order is always delegation → operation, the
 * same order revocation and cancellation use, so revoke/claim serialize.
 * Every permission is re-read from FGA inside the lock; any failure denies.
 */
export async function authorizeAndClaim(
  db: Db,
  ctx: Ctx,
  operationId: string,
  input: ClaimRequest,
): Promise<ClaimResponse> {
  requirePermission(ctx.caller, "claims:create");
  if (ctx.caller.kind !== "service") throw new Error("unreachable");
  const probe = await loadOperation(db, operationId);
  if (!probe || probe.tenant_id !== ctx.tenant.tenantId) throw notFound();
  const d = probe.delegation_id
    ? (await loadDelegation(db, probe.delegation_id, "update"))!
    : null;
  const o = (await loadOperation(db, operationId, true))!;
  const executor = await requireTrustedBackend(ctx, o.organization_id);
  const policy = ctx.tenant.actions[o.action] ?? {
    requesterRelation: o.policy_details.requesterRelation ?? "member",
    approverRelation: o.policy_details.approverRelation ?? "member",
    policyVersion: o.policy_version ?? "none",
  };
  const base = {
    tenantId: o.tenant_id,
    organizationId: o.organization_id,
    delegationId: o.delegation_id,
    operationId: o.id,
    correlationId: o.correlation_id,
    actor: actorOf(ctx),
    at: ctx.now,
  };
  const deny = async (
    code: ConstructorParameters<typeof ServiceError>[0],
    reason: string,
    extra: Record<string, unknown> = {},
    approvalId?: string,
  ): Promise<never> => {
    await audit(db, {
      ...base,
      approvalId,
      type: "authorization.denied",
      decision: "deny",
      reasonCode: reason,
      evaluation: {
        stage: "claim",
        policyVersion: o.policy_version,
        ruleIds: o.rule_ids,
        facts: o.facts,
        actor: o.actor,
        ...extra,
      },
    });
    throw new ServiceError(
      code,
      `Not authorized to dispatch: ${reason.replaceAll("_", " ")}.`,
      {
        reason,
        operationId: o.id,
        ...extra,
      },
    );
  };

  if (input.executionKey !== o.operation_key)
    return deny("operation_conflict", "execution_key_mismatch");

  // --- Recovery: a claim already exists for this logical operation. -----------
  const live = await db.query<ClaimRow>(
    "select * from authority.claims where operation_id=$1 and status <> 'released' limit 1",
    [o.id],
  );
  const existing = live.rows[0];
  if (existing) {
    if (existing.claimed_by !== executor)
      return deny("claim_conflict", "claimed_by_another_executor");
    if (input.operationDigest !== o.digest)
      return deny("operation_changed", "digest_mismatch");
    const dStatus = d ? delegationStatus(d, ctx.now) : "active";
    const stale = existing.lease_expires_at.getTime() <= ctx.now;
    const settled =
      existing.status === "succeeded" || existing.status === "failed";
    // A lost response may be retried within the lease, before revocation. Past the
    // lease, or after revocation, the dispatch outcome is unknown: reconcile.
    if (existing.status === "claimed" && !stale && dStatus === "active") {
      await audit(db, {
        ...base,
        claimId: existing.id,
        approvalId: existing.approval_id,
        type: "claim.recovered",
        decision: "allow",
        evaluation: { seq: existing.seq },
      });
      return {
        decision: "authorized",
        claimId: existing.id,
        operationId: o.id,
        expiresAt: iso(existing.lease_expires_at),
        recovered: true,
        correlationId: o.correlation_id,
      };
    }
    const reason = settled
      ? `claim_${existing.status}`
      : dStatus !== "active"
        ? "delegation_ended_after_claim"
        : stale
          ? "claim_lease_elapsed_without_outcome"
          : `claim_${existing.status}`;
    await audit(db, {
      ...base,
      claimId: existing.id,
      approvalId: existing.approval_id,
      type: "claim.reconciliation_required",
      decision: "deny",
      reasonCode: reason,
      evaluation: { seq: existing.seq, claimStatus: existing.status },
    });
    return {
      decision: "reconcile_required",
      claimId: existing.id,
      operationId: o.id,
      code: "reconcile_required",
      reason,
      correlationId: o.correlation_id,
    };
  }

  // --- Fresh authorization. ---------------------------------------------------
  if (o.status === "cancelled")
    return deny("operation_cancelled", "operation_cancelled");
  if (o.status === "rejected")
    return deny("approval_rejected", "approval_rejected");
  const dStatus = d ? delegationStatus(d, ctx.now) : "active";
  if (dStatus === "revoked")
    return deny("delegation_revoked", "delegation_revoked");
  if (dStatus === "expired")
    return deny("delegation_expired", "delegation_expired");
  if (o.expires_at.getTime() <= ctx.now) {
    await releaseBudgetReservations(db, ctx, o.id);
    return deny("operation_expired", "operation_expired");
  }
  if (input.operationDigest !== o.digest)
    return deny("operation_changed", "digest_mismatch");
  if (
    o.business_state_version !== null &&
    input.businessStateVersion !== o.business_state_version
  )
    return deny("operation_changed", "business_state_version_mismatch");

  if (o.decision === "deny") return deny("not_authorized", o.reason_code);
  if (o.decision === "step_up_required")
    return deny("not_authorized", "insufficient_user_authentication", {
      stepUp: o.policy_details.stepUp,
    });
  const pinned = o.policy_version
    ? await loadPolicy(db, o.tenant_id, o.resource_server, o.policy_version)
    : null;
  let budgetBindings: Awaited<
    ReturnType<typeof budgetAvailability>
  >["bindings"] = [];
  if (
    o.decision === "allow" &&
    o.policy_details.budgetRuleIds?.length &&
    pinned
  ) {
    const identity = {
      delegationId: o.delegation_id,
      principal: o.initiator_id ?? o.actor.id,
      organizationId: o.organization_id,
    };
    const available = await budgetAvailability(
      db,
      ctx,
      pinned,
      o.action,
      o.policy_details.budgetRuleIds,
      identity,
      o.arguments,
      true,
      o.id,
    );
    if (available.exhausted.size) {
      const next = applyRequirementFloor(
        ctx,
        pinned,
        o.action,
        o.arguments,
        o.approval_assertion,
        evaluatePolicy(
          pinned,
          o.action,
          {
            action: o.action,
            resource: o.resource,
            args: o.arguments,
            facts: o.facts,
            actor: o.actor,
            relations: o.policy_details.relationInputs ?? {},
            aggregates: {},
          },
          available.exhausted,
        ),
      );
      await releaseBudgetReservations(db, ctx, o.id);
      await db.query(
        "update authority.operations set decision=$2,reason_code=$3,rule_ids=$4,policy_details=$5,approval_requirement=$6 where id=$1",
        [
          o.id,
          next.decision,
          "budget_exhausted",
          next.ruleIds,
          JSON.stringify(next),
          next.decision === "approval_required" ? "human" : "none",
        ],
      );
      return deny("budget_exhausted", "budget_exhausted", {
        decision: next.decision,
        policyVersion: next.policyVersion,
        ruleIds: next.ruleIds,
      });
    }
    budgetBindings = available.bindings;
  }
  let approval: ApprovalRow | null = null;
  if (o.approval_requirement === "human") {
    const r = await db.query<ApprovalRow>(
      "select * from authority.approvals where operation_id=$1 order by (status in ('pending','approved')) desc, requested_at desc, id desc limit 1 for update",
      [o.id],
    );
    approval = r.rows[0] ?? null;
    if (!approval) return deny("approval_required", "approval_required");
    if (approval.operation_digest !== o.digest)
      return deny(
        "operation_changed",
        "approval_bound_to_different_digest",
        {},
        approval.id,
      );
    if (approval.status === "rejected")
      return deny("approval_rejected", "approval_rejected", {}, approval.id);
    if (
      approval.status === "pending" &&
      approval.expires_at.getTime() > ctx.now
    )
      return deny("approval_pending", "approval_pending", {}, approval.id);
    if (
      approval.status === "expired" ||
      approval.expires_at.getTime() <= ctx.now
    ) {
      if (approval.status !== "expired") {
        await db.query(
          "update authority.approvals set status='expired' where id=$1",
          [approval.id],
        );
        await audit(db, {
          ...base,
          approvalId: approval.id,
          type: "approval.expired",
          actor: { kind: "system", id: "task-authority" },
          decision: "info",
          reasonCode: "approval_window_elapsed",
        });
      }
      return deny("approval_expired", "approval_expired", {}, approval.id);
    }
  }

  // Current permissions, re-read now. FGA outages raise authorization_unavailable
  // (fail closed) and are recorded before the error propagates.
  const checks: string[] = [
    "delegation",
    "operation_digest",
    "trusted_backend",
  ];
  try {
    await runPermissionChecks(db, ctx, d, o, approval, policy, checks, deny);
  } catch (e) {
    if (e instanceof ServiceError && e.code === "authorization_unavailable")
      await deny("authorization_unavailable", "fga_unavailable");
    throw e;
  }

  const day = new Date(ctx.now).toISOString().slice(0, 10);
  const usage = await db.query<{ count: string }>(
    `insert into authority.usage_counters (tenant_id, day, metric, count) values ($1,$2,'claims',1)
     on conflict (tenant_id, day, metric) do update set count = authority.usage_counters.count + 1
     returning count`,
    [o.tenant_id, day],
  );
  if (Number(usage.rows[0]!.count) > ctx.tenant.quotas.claimsPerDay)
    throw new ServiceError("quota_exceeded", "Daily claim quota reached.");

  const prior = await db.query<{ n: string }>(
    "select count(*) n from authority.claims where operation_id=$1",
    [o.id],
  );
  const seq = Number(prior.rows[0]!.n) + 1;
  const id = ctx.newId("clm");
  const lease = ctx.now + ctx.tenant.defaults.claimLeaseSec * 1000;
  const authority = {
    tenantId: o.tenant_id,
    organizationId: o.organization_id,
    ownerType: d?.owner_type ?? "user",
    actorId: d?.actor_id ?? o.initiator_id,
    agentId: d?.agent_id ?? null,
    initiatorId: o.initiator_id,
    approverId: approval?.approver_id ?? null,
    approvalId: approval?.id ?? null,
    checkedAt: iso(ctx.now),
    checks,
  };
  await db.query(
    `insert into authority.claims
     (id, tenant_id, organization_id, operation_id, delegation_id, approval_id, seq, status,
      execution_key, claimed_by, effective_authority, correlation_id, minted_at, lease_expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,'claimed',$8,$9,$10,$11,$12,$13)`,
    [
      id,
      o.tenant_id,
      o.organization_id,
      o.id,
      d?.id ?? null,
      approval?.id ?? null,
      seq,
      input.executionKey,
      executor,
      JSON.stringify(authority),
      o.correlation_id,
      iso(ctx.now),
      iso(lease),
    ],
  );
  if (pinned && budgetBindings.length)
    await consumeBudgets(db, ctx, pinned, o, id, budgetBindings);
  await db.query(
    "update authority.operations set status='claimed' where id=$1",
    [o.id],
  );
  await audit(db, {
    ...base,
    claimId: id,
    approvalId: approval?.id ?? null,
    type: "authorization.allowed",
    decision: "allow",
    evaluation: {
      stage: "claim",
      checks,
      policyVersion: o.policy_version,
      ruleIds: o.rule_ids,
      actor: o.actor,
      facts: o.facts,
    },
  });
  await audit(db, {
    ...base,
    claimId: id,
    approvalId: approval?.id ?? null,
    type: "claim.created",
    decision: "allow",
    evaluation: { seq, leaseExpiresAt: iso(lease) },
  });
  return {
    decision: "authorized",
    claimId: id,
    operationId: o.id,
    expiresAt: iso(lease),
    recovered: false,
    correlationId: o.correlation_id,
  };
}

async function runPermissionChecks(
  db: Db,
  ctx: Ctx,
  d: DelegationRow | null,
  o: OperationRow,
  approval: ApprovalRow | null,
  policy: Ctx["tenant"]["actions"][string],
  checks: string[],
  deny: (
    c: any,
    r: string,
    e?: Record<string, unknown>,
    a?: string,
  ) => Promise<never>,
) {
  const fga = ctx.tenant.fga;
  const orgObj = org(o.organization_id);
  if (
    d &&
    !(await fgaCheck(fga, `agent:${d.agent_id}`, "registered_agent", orgObj))
  )
    await deny("not_authorized", "agent_no_longer_registered");
  if (d) checks.push("agent_registered");
  if (!d || d.owner_type === "user") {
    // User-owned authority ends the moment the owner loses the permission.
    if (
      !(await fgaCheck(
        fga,
        `user:${d?.actor_id ?? o.initiator_id}`,
        policy.requesterRelation,
        orgObj,
      ))
    )
      await deny("not_authorized", "owner_permission_lost");
    checks.push("owner_permission");
  } else {
    checks.push("organization_policy");
  }
  if (approval) {
    const approver = approval.approver_id!;
    const self = approver === o.initiator_id || approver === d?.actor_id;
    if (self && ownerMayApprove(o, d) && approver === d!.actor_id) {
      // The owner's own permission was re-checked above; policy allows the
      // owner to approve their agent's operation with a passkey.
      checks.push("owner_self_approval");
    } else {
      if (self)
        await deny(
          "approver_ineligible",
          "initiator_cannot_approve",
          {},
          approval.id,
        );
      if (
        !(await fgaCheck(fga, `user:${approver}`, approval.permission, orgObj))
      )
        await deny(
          "approver_ineligible",
          "approver_permission_lost",
          {},
          approval.id,
        );
    }
    const quorum = o.policy_details.quorum ?? 1;
    if (quorum > 1) {
      const votes = await db.query<{ reviewer_id: string }>(
        "select reviewer_id from authority.approval_decisions where approval_id=$1 and decision='approve'",
        [approval.id],
      );
      const reviewers = [...new Set(votes.rows.map((v) => v.reviewer_id))];
      if (reviewers.length < quorum)
        await deny(
          "approval_required",
          "approval_quorum_not_met",
          {},
          approval.id,
        );
      for (const reviewer of reviewers) {
        if (
          reviewer === o.initiator_id ||
          reviewer === d?.actor_id ||
          !(await fgaCheck(
            fga,
            `user:${reviewer}`,
            approval.permission,
            orgObj,
          ))
        )
          await deny(
            "approver_ineligible",
            "approver_permission_lost",
            {},
            approval.id,
          );
      }
      checks.push("approval_quorum");
    }
    checks.push(
      "approver_permission",
      "approver_not_initiator",
      "approval_unexpired",
    );
  }
}

/**
 * Customer-attested outcome. This is recorded as unverified evidence and never
 * authorizes anything. `not_submitted` releases the claim so a *fresh* claim
 * (with all checks repeated) may be minted for the same logical operation.
 */
export async function reportOutcome(
  db: Db,
  ctx: Ctx,
  operationId: string,
  input: OutcomeReport,
): Promise<OutcomeResponse> {
  requirePermission(ctx.caller, "outcomes:report");
  const probe = await loadOperation(db, operationId);
  if (!probe || probe.tenant_id !== ctx.tenant.tenantId) throw notFound();
  if (probe.delegation_id)
    await loadDelegation(db, probe.delegation_id, "update");
  const o = (await loadOperation(db, operationId, true))!;
  const executor = await requireTrustedBackend(ctx, o.organization_id);
  const r = await db.query<ClaimRow>(
    "select * from authority.claims where id=$1 and operation_id=$2 for update",
    [input.claimId, o.id],
  );
  const c = r.rows[0];
  if (!c || c.claimed_by !== executor) throw notFound();
  const same =
    (c.outcome as any)?.providerStatus === input.providerStatus &&
    ((c.outcome as any)?.providerReference ?? null) ===
      (input.providerReference ?? null);
  const terminal =
    c.status === "succeeded" ||
    c.status === "failed" ||
    c.status === "released";
  if (terminal) {
    if (same) return outcomeResponse(c, o);
    throw new ServiceError(
      "operation_conflict",
      "An outcome was already recorded for this claim.",
      {
        claimStatus: c.status,
      },
    );
  }
  const nextClaim =
    input.providerStatus === "not_submitted"
      ? "released"
      : input.providerStatus;
  const nextOp =
    input.providerStatus === "succeeded" || input.providerStatus === "failed"
      ? "settled"
      : input.providerStatus === "not_submitted"
        ? "registered"
        : "claimed";
  const outcome = {
    providerStatus: input.providerStatus,
    providerReference: input.providerReference ?? null,
    detail: input.detail ?? null,
    reportedAt: iso(ctx.now),
    attestation: "customer_reported_unverified",
  };
  await db.query(
    "update authority.claims set status=$2, outcome=$3 where id=$1",
    [c.id, nextClaim, JSON.stringify(outcome)],
  );
  await db.query("update authority.operations set status=$2 where id=$1", [
    o.id,
    nextOp,
  ]);
  if (input.providerStatus === "not_submitted")
    await releaseBudgetReservations(db, ctx, o.id);
  await bump(db, ctx, "outcomes");
  await audit(db, {
    tenantId: o.tenant_id,
    organizationId: o.organization_id,
    delegationId: o.delegation_id,
    operationId: o.id,
    claimId: c.id,
    approvalId: c.approval_id,
    correlationId: o.correlation_id,
    type: "outcome.reported",
    actor: actorOf(ctx),
    decision: "info",
    reasonCode: input.providerStatus,
    evaluation: {
      providerStatus: input.providerStatus,
      providerReference: input.providerReference ?? null,
      attestation: "customer_reported_unverified",
    },
    at: ctx.now,
  });
  return outcomeResponse(
    { ...c, status: nextClaim as ClaimRow["status"] },
    { ...o, status: nextOp as OperationRow["status"] },
  );
}

function outcomeResponse(c: ClaimRow, o: OperationRow): OutcomeResponse {
  return {
    operationId: o.id,
    claimId: c.id,
    claimStatus: c.status,
    operationStatus: o.status,
    unverifiedCustomerAttestation: true,
    correlationId: o.correlation_id,
  };
}

export { LIVE };
