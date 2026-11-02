import { randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import {
  actionDigest,
  approvalConfig,
  verifyApproval,
  type ApprovalRequest,
} from "@task-authority/sdk/approve/verify";
import {
  idleTimeoutMs,
  milliseconds,
  releaseBudgetReservations,
} from "./policies.js";
import type {
  ApprovalView,
  Decision,
  RequestApproval,
} from "@task-authority/contracts";
import { audit } from "./audit.js";
import {
  requirePermission,
  subjectFromAccessToken,
  type Subject,
} from "./authn.js";
import { CibaUnavailable, pollCiba, startCiba } from "./ciba.js";
import {
  actorOf,
  canRead,
  delegationStatus,
  notFound,
  org,
  requireTrustedBackend,
  type Ctx,
} from "./context.js";
import { loadDelegation } from "./delegations.js";
import { ServiceError } from "./errors.js";
import { fgaCheck } from "./fga.js";
import { loadOperation } from "./operations.js";
import { bump } from "./usage.js";
import {
  iso,
  type ApprovalRow,
  type Db,
  type DelegationRow,
  type OperationRow,
} from "./store.js";

export const APPROVAL_DETAIL_TYPE = "task_authority_approval";

export function approvalView(a: ApprovalRow, op?: OperationRow): ApprovalView {
  return {
    id: a.id,
    operationId: a.operation_id,
    operationDigest: a.operation_digest,
    status: a.status,
    permission: a.permission,
    requestedAt: iso(a.requested_at),
    expiresAt: iso(a.expires_at),
    decidedAt: a.decided_at ? iso(a.decided_at) : null,
    method: a.method,
    lease:
      a.lease_reviewer_id && a.lease_expires_at
        ? {
            reviewerId: a.lease_reviewer_id,
            expiresAt: iso(a.lease_expires_at),
          }
        : null,
    correlationId: a.correlation_id,
    ...(op
      ? {
          operation: {
            action: op.action,
            resource: op.resource,
            arguments: op.arguments,
            organizationId: op.organization_id,
          },
        }
      : {}),
  };
}

async function loadApproval(db: Db, id: string, lock = false) {
  const r = await db.query<ApprovalRow>(
    `select * from authority.approvals where id=$1 ${lock ? "for update" : ""}`,
    [id],
  );
  return r.rows[0] ?? null;
}

/**
 * The policy lets the user who owns an agent's delegation approve that agent's operation
 * themselves (self_approval: owner). Only user-owned delegations, only single-approver
 * decisions; human-direct operations keep separation of duties.
 */
export function ownerMayApprove(o: OperationRow, d: DelegationRow | null) {
  return (
    Boolean(d) &&
    d!.owner_type === "user" &&
    o.policy_details?.selfApproval === "owner" &&
    (o.policy_details?.quorum ?? 1) === 1
  );
}

/**
 * Who `sub` is for this approval, re-read from FGA: an eligible reviewer (approver relation,
 * never the initiator or owner), the owner under self_approval (still holding the requester
 * relation), or nobody.
 */
export async function approverRole(
  ctx: Ctx,
  sub: string,
  permission: string,
  o: OperationRow,
  d: DelegationRow | null,
): Promise<"reviewer" | "owner" | null> {
  if (sub === o.initiator_id || sub === d?.actor_id) {
    if (!ownerMayApprove(o, d) || sub !== d!.actor_id) return null;
    const relation =
      ctx.tenant.actions[o.action]?.requesterRelation ??
      o.policy_details?.requesterRelation ??
      "member";
    return (await fgaCheck(
      ctx.tenant.fga,
      `user:${sub}`,
      relation,
      org(o.organization_id),
    ))
      ? "owner"
      : null;
  }
  return (await fgaCheck(
    ctx.tenant.fga,
    `user:${sub}`,
    permission,
    org(o.organization_id),
  ))
    ? "reviewer"
    : null;
}

/**
 * Redeem an Auth0 approve() proof into the existing Task Authority approval row.
 * The request fields are reconstructed from the locked operation and approval rows;
 * only the signed proof crosses the API boundary.
 */
export async function recordApprovalProof(
  db: Db,
  ctx: Ctx,
  approvalId: string,
  input: { proof: string },
): Promise<ApprovalView> {
  requirePermission(ctx.caller, "approvals:request");
  const a = await loadApproval(db, approvalId);
  if (!a || a.tenant_id !== ctx.tenant.tenantId)
    throw new ServiceError("not_authorized", DECISION_DENIED);
  const op0 = await loadOperation(db, a.operation_id);
  if (!op0 || op0.tenant_id !== ctx.tenant.tenantId)
    throw new ServiceError("not_authorized", DECISION_DENIED);
  await requireTrustedBackend(ctx, op0.organization_id);
  if (!ctx.tenant.approvalClientId)
    throw new ServiceError(
      "internal_error",
      "No approval Web App is configured.",
    );

  let decoded: Record<string, unknown>;
  try {
    decoded = decodeJwt(input.proof) as Record<string, unknown>;
  } catch {
    throw new ServiceError(
      "invalid_request",
      "The approval proof is malformed.",
    );
  }
  const sub = typeof decoded.sub === "string" ? decoded.sub : "";
  if (!sub)
    throw new ServiceError(
      "invalid_request",
      "The approval proof has no subject.",
    );
  const args = op0.arguments as ApprovalRequest["args"];
  const version = op0.digest;
  const request: ApprovalRequest = {
    v: 1,
    id: a.id,
    action: op0.action,
    resource: op0.resource,
    args,
    // Task Authority's digest covers tenant, organization, delegation and the
    // operation key as well as the action. Bind that digest as the approval
    // request version, then compute approve()'s own canonical action digest.
    // This lets verifyApproval validate both the exact user-visible arguments
    // and the Task Authority operation that is being decided.
    version,
    digest: await actionDigest({
      action: op0.action,
      resource: op0.resource,
      args,
      version,
    }),
    run: op0.id,
    step: a.id,
    approvers: { users: [sub] },
    ...(op0.initiator_id ? { requester: op0.initiator_id } : {}),
    via: "link",
    iat: Math.floor(a.requested_at.getTime() / 1000),
    exp: Math.floor(a.expires_at.getTime() / 1000),
  };
  const cfg = approvalConfig(
    {},
    {
      domain: new URL(ctx.tenant.issuer).host,
      issuer: ctx.tenant.issuer,
      clientId: ctx.tenant.approvalClientId,
      clientSecret: "unused-by-verification",
      appUrl: ctx.tenant.issuer,
      fetch: ctx.tenant.approvalFetch,
      claimNamespace: ctx.tenant.claimNamespace,
      clockSkew: ctx.config.clockSkewSec,
    },
  );
  const approval = await verifyApproval(cfg, request, input.proof, ctx.now);
  const subject: Subject = {
    sub: approval.approver.sub,
    orgId: approval.orgId,
    amr: approval.amr,
    authTime: approval.at,
    grants: [],
    iat: Number(decoded.iat ?? approval.at),
    jti: approval.tokenId,
    authorizationDetails: [],
    actorType: "human",
  };
  const op = (await loadOperation(db, op0.id, true))!;
  return recordDecision(
    db,
    ctx,
    approvalId,
    subject,
    { decision: approval.decision, operationDigest: op.digest },
    {
      orgClaimRequired: false,
      tokenId: approval.tokenId ?? approval.key,
      linkProof: { method: "passkey", authTime: approval.at },
    },
  );
}

async function expire(db: Db, a: ApprovalRow, o: OperationRow, ctx: Ctx) {
  await db.query(
    "update authority.approvals set status='expired' where id=$1",
    [a.id],
  );
  await releaseBudgetReservations(db, ctx, o.id);
  await audit(db, {
    type: "approval.expired",
    tenantId: a.tenant_id,
    organizationId: a.organization_id,
    delegationId: o.delegation_id,
    operationId: o.id,
    approvalId: a.id,
    correlationId: a.correlation_id,
    actor: { kind: "system", id: "task-authority" },
    decision: "info",
    reasonCode: "approval_window_elapsed",
    at: ctx.now,
  });
}

export async function requestApproval(
  db: Db,
  ctx: Ctx,
  operationId: string,
  input: RequestApproval & { reviewerSubject?: string },
  escalation = false,
): Promise<ApprovalView> {
  requirePermission(ctx.caller, "approvals:request");
  const probe = await loadOperation(db, operationId);
  if (!probe || probe.tenant_id !== ctx.tenant.tenantId) throw notFound();
  const d = probe.delegation_id
    ? (await loadDelegation(db, probe.delegation_id, "update"))!
    : null;
  const o = (await loadOperation(db, operationId, true))!;
  await requireTrustedBackend(ctx, o.organization_id);
  const policy = {
    ...ctx.tenant.actions[o.action],
    approverRelation:
      ctx.tenant.actions[o.action]?.approverRelation ??
      o.policy_details?.approverRelation,
    policyVersion:
      o.policy_version ?? ctx.tenant.actions[o.action]?.policyVersion,
  };
  const status = d ? delegationStatus(d, ctx.now) : "active";
  if (status === "revoked") throw new ServiceError("delegation_revoked");
  if (status === "expired" || o.expires_at.getTime() <= ctx.now)
    throw new ServiceError("delegation_expired");
  if (o.approval_requirement !== "human")
    throw new ServiceError(
      "invalid_request",
      "This operation does not require human approval.",
    );
  if (o.status === "cancelled") throw new ServiceError("operation_cancelled");
  if (o.status === "rejected") throw new ServiceError("approval_rejected");
  if (o.status !== "registered")
    throw new ServiceError("operation_conflict", "Operation already claimed.");
  const channel = escalation ? "ciba" : "portal";
  if (channel === "ciba" && (!ctx.tenant.ciba || !input.reviewerSubject))
    throw new ServiceError(
      "invalid_request",
      "CIBA needs a configured provider and a reviewerSubject.",
    );
  if (input.permission && input.permission !== policy.approverRelation)
    throw new ServiceError(
      "invalid_request",
      "Permission does not match the tenant policy for this action.",
    );

  let provisional = false;
  const live = await db.query<ApprovalRow>(
    "select * from authority.approvals where operation_id=$1 and status in ('pending','approved') for update",
    [o.id],
  );
  const cur = live.rows[0];
  if (cur) {
    if (cur.expires_at.getTime() > ctx.now) {
      // An approval whose approver has since lost eligibility is not a live decision:
      // supersede it so a fresh, eligible human decision can be requested.
      let lost =
        cur.status === "approved" &&
        !(await approverRole(ctx, cur.approver_id!, cur.permission, o, d));
      if (
        cur.status === "approved" &&
        !lost &&
        (o.policy_details?.quorum ?? 1) > 1
      ) {
        const votes = await db.query<{ reviewer_id: string }>(
          "select reviewer_id from authority.approval_decisions where approval_id=$1 and decision='approve'",
          [cur.id],
        );
        let eligible = 0;
        for (const v of votes.rows)
          if (
            await fgaCheck(
              ctx.tenant.fga,
              `user:${v.reviewer_id}`,
              cur.permission,
              org(o.organization_id),
            )
          )
            eligible++;
        lost = eligible < (o.policy_details?.quorum ?? 1);
      }
      if (!lost && !(escalation && cur.method !== "ciba_rar"))
        return approvalView(cur);
      // Superseding is provisional until the new channel is known to work: a failure past this
      // point rolls back to here and leaves the live approval exactly as it was.
      await db.query("savepoint supersede_approval");
      provisional = true;
      await db.query(
        "update authority.approvals set status='expired' where id=$1",
        [cur.id],
      );
      await audit(db, {
        type: "approval.expired",
        tenantId: cur.tenant_id,
        organizationId: cur.organization_id,
        delegationId: o.delegation_id,
        operationId: o.id,
        approvalId: cur.id,
        correlationId: cur.correlation_id,
        actor: { kind: "system", id: "task-authority" },
        decision: "info",
        reasonCode: escalation
          ? "approval_escalated"
          : "approver_eligibility_lost",
        at: ctx.now,
      });
    } else {
      await expire(db, cur, o, ctx);
    }
  }
  const finish = async (): Promise<ApprovalView> => {
    const open = await db.query<{ n: string }>(
      "select count(*) n from authority.approvals where tenant_id=$1 and status='pending' and expires_at > $2",
      [o.tenant_id, iso(ctx.now)],
    );
    if (Number(open.rows[0]!.n) >= ctx.tenant.quotas.openApprovals)
      throw new ServiceError("quota_exceeded", "Open approval quota reached.");

    const id = ctx.newId("apr");
    const expires = Math.min(
      ctx.now +
        (o.policy_details?.ttl
          ? milliseconds(o.policy_details.ttl)
          : ctx.tenant.defaults.approvalTtlSec * 1000),
      o.expires_at.getTime(),
      d?.expires_at.getTime() ?? Infinity,
    );
    // Durable intent first: the approval row exists before any external side effect.
    await db.query(
      `insert into authority.approvals
     (id, tenant_id, organization_id, operation_id, operation_digest, permission, reviewer_hint,
      status, method, correlation_id, policy_source, requested_at, expires_at, reviewer_subject)
     values ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$12,$13)`,
      [
        id,
        o.tenant_id,
        o.organization_id,
        o.id,
        o.digest,
        policy.approverRelation,
        input.reviewerHint ??
          (escalation ? input.reviewerSubject : null) ??
          null,
        channel === "ciba" ? "ciba_rar" : "portal_stepup",
        o.correlation_id,
        `fga:${policy.policyVersion}`,
        iso(ctx.now),
        iso(expires),
        channel === "ciba" ? input.reviewerSubject! : null,
      ],
    );
    await bump(db, ctx, "approvals");
    await audit(db, {
      type: "approval.requested",
      tenantId: o.tenant_id,
      organizationId: o.organization_id,
      delegationId: o.delegation_id,
      operationId: o.id,
      approvalId: id,
      correlationId: o.correlation_id,
      actor: actorOf(ctx),
      decision: "info",
      evaluation: {
        permission: policy.approverRelation,
        expiresAt: iso(expires),
        method: channel === "ciba" ? "ciba_rar" : "portal_stepup",
        operationDigest: o.digest,
      },
      at: ctx.now,
    });
    if (channel === "ciba") {
      try {
        const started = await startCiba(ctx.tenant.ciba!, {
          sub: input.reviewerSubject!,
          requestedExpirySec: Math.floor((expires - ctx.now) / 1000),
          message: `Approve ${o.action} ${o.resource} (${o.digest.slice(7, 15)})`,
          details:
            ctx.tenant.ciba!.rar === false
              ? undefined
              : [
                  {
                    type: APPROVAL_DETAIL_TYPE,
                    approval_id: id,
                    operation_digest: o.digest,
                  },
                ],
        });
        await db.query(
          "update authority.approvals set ciba_auth_req_id=$2 where id=$1",
          [id, started.authReqId],
        );
      } catch (e) {
        if (!(e instanceof CibaUnavailable)) throw e;
        // The challenge never reached the reviewer: close the intent so it cannot linger as pending.
        await db.query(
          "update authority.approvals set status='expired' where id=$1",
          [id],
        );
        await audit(db, {
          type: "approval.expired",
          tenantId: o.tenant_id,
          organizationId: o.organization_id,
          delegationId: o.delegation_id,
          operationId: o.id,
          approvalId: id,
          correlationId: o.correlation_id,
          actor: { kind: "system", id: "task-authority" },
          decision: "info",
          reasonCode: "ciba_initiation_failed",
          at: ctx.now,
        });
        throw new ServiceError(
          "authorization_unavailable",
          "The approval channel is unavailable. No approval was requested.",
          { dependency: "ciba" },
        );
      }
    }
    return approvalView((await loadApproval(db, id))!);
  };
  if (!provisional) return finish();
  try {
    const view = await finish();
    await db.query("release savepoint supersede_approval");
    return view;
  } catch (e) {
    await db.query("rollback to savepoint supersede_approval");
    await db.query("release savepoint supersede_approval");
    if (e instanceof ServiceError && e.details?.dependency === "ciba")
      await audit(db, {
        type: "authorization.denied",
        tenantId: o.tenant_id,
        organizationId: o.organization_id,
        delegationId: o.delegation_id,
        operationId: o.id,
        approvalId: cur?.id,
        correlationId: o.correlation_id,
        actor: { kind: "system", id: "task-authority" },
        decision: "deny",
        reasonCode: "ciba_initiation_failed",
        evaluation: { stage: "approval.escalate" },
        at: ctx.now,
      });
    throw e;
  }
}

export async function getApproval(
  db: Db,
  ctx: Ctx,
  id: string,
): Promise<ApprovalView> {
  // The review queue and its details are for people, not for an agent holding a person's token.
  if (ctx.caller.kind === "user" && isAgentSubject(ctx.caller.subject))
    throw new ServiceError("invalid_identity", AGENT_CANNOT_APPROVE);
  const a = await loadApproval(db, id);
  if (!a) throw notFound();
  const o = (await loadOperation(db, a.operation_id))!;
  const d = o.delegation_id
    ? (await loadDelegation(db, o.delegation_id))!
    : null;
  // Reviewers (holders of the approver relation) may see the exact operation.
  if (
    !(await canRead(
      ctx,
      db,
      a,
      [o.initiator_id, d?.actor_id].filter((x): x is string => Boolean(x)),
      "approvals:read",
      a.permission,
    ))
  )
    throw notFound();
  const view = approvalView(a, o);
  if (a.status === "pending" && a.expires_at.getTime() <= ctx.now)
    view.status = "expired";
  // Tells the approval page whether this person decides as a reviewer or as the agent's owner
  // (an owner always confirms with a fresh, operation-bound step-up).
  if (ctx.caller.kind === "user")
    view.viewerRole = await approverRole(
      ctx,
      ctx.caller.subject.sub,
      a.permission,
      o,
      d,
    );
  return view;
}

const DECISION_DENIED = "Not found or not permitted.";

/**
 * A token carrying `act` (token exchange / delegation) or `sub_profile: ai_agent` is an
 * agent acting for a person, never the person reviewing. Checked on every approval channel.
 */
function isAgentSubject(subject: Subject) {
  return subject.actorType === "agent";
}
const AGENT_CANNOT_APPROVE = "An agent token cannot review or approve.";
/** Factors an owner approval needs when the tier does not list its own. */
const OWNER_FACTORS = ["webauthn-platform", "webauthn-roaming"];

export async function decide(
  db: Db,
  ctx: Ctx,
  approvalId: string,
  input: Decision,
): Promise<ApprovalView> {
  if (ctx.caller.kind !== "user")
    throw new ServiceError(
      "invalid_identity",
      "A human approver token is required.",
    );
  return recordDecision(db, ctx, approvalId, ctx.caller.subject, input, {
    orgClaimRequired: true,
  });
}

/**
 * The single place where a decision is verified and recorded, for every approval
 * channel: assurance (MFA, freshness), binding to approval id + digest, single-use
 * token id, current FGA eligibility, and separation of duties.
 */
async function recordDecision(
  db: Db,
  ctx: Ctx,
  approvalId: string,
  subject: Subject,
  input: Decision,
  opts: {
    orgClaimRequired: boolean;
    /**
     * CIBA without RAR (opt-in per tenant, CIBA_RAR=0): the service started the backchannel
     * request itself and holds its id, so the binding to this approval is server-side and the
     * provider's device approval is the second factor. Token-carried MFA claims and
     * authorization_details are not required. Recorded in the assurance and audit trail.
     */
    channelAttested?: boolean;
    /** Single-use key when the token carries no jti. */
    tokenId?: string;
    batchTokenConsumed?: boolean;
    /** The Auth0-signed approve() ID token already proved a fresh passkey and binding. */
    linkProof?: { method: "passkey"; authTime: number };
  },
): Promise<ApprovalView> {
  const probe = await loadApproval(db, approvalId);
  // An agent gets the same refusal for real and unknown ids (the real one is also audited below).
  if (
    isAgentSubject(subject) &&
    (!probe || probe.tenant_id !== ctx.tenant.tenantId)
  )
    throw new ServiceError("invalid_identity", undefined, {
      reason: "agent_cannot_approve",
    });
  // Unknown ids, other tenants and other organizations are indistinguishable.
  if (!probe || probe.tenant_id !== ctx.tenant.tenantId)
    throw new ServiceError("not_authorized", DECISION_DENIED);
  const base = {
    tenantId: probe.tenant_id,
    organizationId: probe.organization_id,
    approvalId: probe.id,
    operationId: probe.operation_id,
    correlationId: probe.correlation_id,
    actor: { kind: "user" as const, id: subject.sub },
    at: ctx.now,
  };
  const deny = async (
    code: ConstructorParameters<typeof ServiceError>[0],
    reason: string,
    publicCode = code,
  ) => {
    await audit(db, {
      ...base,
      type: "authorization.denied",
      decision: "deny",
      reasonCode: reason,
      evaluation: { stage: "approval.decision", decision: input.decision },
    });
    throw new ServiceError(
      publicCode,
      publicCode === "not_authorized" ? DECISION_DENIED : undefined,
      { reason },
    );
  };
  if (isAgentSubject(subject))
    return deny("invalid_identity", "agent_cannot_approve");
  if (
    opts.orgClaimRequired
      ? subject.orgId !== probe.organization_id
      : subject.orgId && subject.orgId !== probe.organization_id
  )
    return deny("not_authorized", "approver_org_mismatch");

  const o0 = (await loadOperation(db, probe.operation_id))!;
  const d = o0.delegation_id
    ? (await loadDelegation(db, o0.delegation_id, "update"))!
    : null;
  const o = (await loadOperation(db, o0.id, true))!;
  const a = (await loadApproval(db, approvalId, true))!;
  const role = await approverRole(ctx, subject.sub, a.permission, o, d);
  if (!role)
    return deny(
      "approver_ineligible",
      subject.sub === o.initiator_id || subject.sub === d?.actor_id
        ? "initiator_cannot_approve"
        : "not_org_approver",
    );
  const owner = role === "owner";
  if (
    a.lease_reviewer_id &&
    a.lease_reviewer_id !== subject.sub &&
    a.lease_expires_at &&
    a.lease_expires_at.getTime() > ctx.now &&
    (await fgaCheck(
      ctx.tenant.fga,
      `user:${a.lease_reviewer_id}`,
      a.permission,
      org(o.organization_id),
    ))
  )
    return deny("operation_conflict", "approval_leased_by_another_reviewer");
  const previousVote = await db.query<{ decision: string }>(
    "select decision from authority.approval_decisions where approval_id=$1 and reviewer_id=$2",
    [a.id, subject.sub],
  );
  if (a.status === "pending" && previousVote.rows[0]) {
    if (
      previousVote.rows[0].decision === input.decision &&
      a.operation_digest === input.operationDigest
    )
      return approvalView(a);
    return deny("operation_conflict", "reviewer_already_decided");
  }
  const same = (a.status === "approved") === (input.decision === "approve");

  // Idempotent replay of an already-recorded decision by the same approver.
  if (a.status === "approved" || a.status === "rejected") {
    if (
      a.approver_id === subject.sub &&
      same &&
      a.operation_digest === input.operationDigest
    )
      return approvalView(a);
    return deny("operation_conflict", "decision_already_recorded");
  }
  if (a.status === "expired" || a.expires_at.getTime() <= ctx.now) {
    if (a.status === "pending") await expire(db, a, o, ctx);
    return deny("approval_expired", "approval_expired");
  }
  const dStatus = d ? delegationStatus(d, ctx.now) : "active";
  if (dStatus === "revoked")
    return deny("delegation_revoked", "delegation_revoked");
  if (dStatus === "expired" || o.expires_at.getTime() <= ctx.now)
    return deny("delegation_expired", "delegation_expired");
  if (o.status !== "registered")
    return deny("operation_cancelled", `operation_${o.status}`);
  if (
    input.operationDigest !== a.operation_digest ||
    a.operation_digest !== o.digest
  )
    return deny("operation_changed", "digest_mismatch");

  // Session assurance is allowed only by the immutable policy snapshot.
  const tier = (o.policy_details?.assurance ?? {}) as Record<string, unknown>;
  // An owner approving their own agent's operation never rides a review session: every
  // approval is a fresh step-up bound to this operation's digest.
  const session =
    a.method !== "ciba_rar" &&
    !opts.channelAttested &&
    !opts.linkProof &&
    ((tier.assurance === "session_mfa" &&
      !(owner && input.decision === "approve")) ||
      (input.decision === "reject" && Boolean(subject.dpopJkt)));
  const attested = opts.channelAttested === true;
  // A rejection grants nothing (PRD: tier-1 assurance), so a signed-in reviewer whose token
  // is bound to their device (DPoP) may reject without a second factor or a fresh sign-in.
  // Eligibility, the digest and the audit record still apply.
  const plainReject =
    session && input.decision === "reject" && Boolean(subject.dpopJkt);
  if (
    !attested &&
    !opts.linkProof &&
    !plainReject &&
    !subject.amr.includes("mfa")
  )
    return deny("not_authorized", "mfa_required");
  // Sender-constraining: session tiers demand a DPoP-bound token unless the tier says optional;
  // per-operation tiers only when they say required. CIBA tokens are issued to the service itself.
  const dpopNeeded =
    a.method !== "ciba_rar" &&
    !attested &&
    !opts.linkProof &&
    (session ? tier.dpop !== "optional" : tier.dpop === "required");
  if (dpopNeeded && !subject.dpopJkt)
    return deny("not_authorized", "dpop_required");
  // The evidence is the signed amr values. The shipped Action asserts "mfa" plus the completed
  // factor's method name, so a tier that lists factors is satisfied only by a token whose amr
  // names one of them; a bare "mfa" cannot tell webauthn from otp and fails closed.
  // An owner approval always needs a passkey: the tier's WebAuthn factors if it names any,
  // otherwise either WebAuthn factor. OTP never satisfies an owner approving their own agent.
  const tierFactors = Array.isArray(tier.factors)
    ? (tier.factors as unknown[])
    : null;
  const ownerFactors = tierFactors?.filter((f) =>
    OWNER_FACTORS.includes(f as string),
  );
  const required = owner
    ? ownerFactors?.length
      ? ownerFactors
      : OWNER_FACTORS
    : tierFactors;
  const factors = (required ?? []) as unknown[];
  if (
    input.decision === "approve" &&
    !attested &&
    required &&
    !(opts.linkProof?.method === "passkey"
      ? factors.some((f) => OWNER_FACTORS.includes(String(f)))
      : factors.some((f) => typeof f === "string" && subject.amr.includes(f)))
  )
    return deny("not_authorized", "factor_not_satisfied");
  const maxAge = session
    ? Number(tier.max_age ?? 3600)
    : Number(tier.max_age ?? ctx.tenant.defaults.decisionMaxAgeSec);
  const authTime = attested
    ? subject.iat
    : (opts.linkProof?.authTime ?? subject.authTime);
  // A plain rejection is bounded by the token's own lifetime, not the tier's age.
  if (
    !plainReject &&
    (authTime === null ||
      authTime > ctx.now / 1000 + ctx.config.clockSkewSec ||
      ctx.now / 1000 - authTime > maxAge ||
      (!session &&
        authTime * 1000 <
          a.requested_at.getTime() - ctx.config.clockSkewSec * 1000))
  )
    return deny("not_authorized", "step_up_stale_or_before_request");
  let challengeBound = false;
  if (!session && !attested && subject.approvalChallenge) {
    const binding = await db.query<{ requested_at: Date }>(
      "select requested_at from authority.approval_challenges where challenge=$1 and tenant_id=$2 and approval_id=$3 and operation_digest=$4 and reviewer_id=$5 and jkt=$6 and expires_at>$7 and used_at is null for update",
      [
        subject.approvalChallenge,
        a.tenant_id,
        a.id,
        a.operation_digest,
        subject.sub,
        subject.dpopJkt,
        iso(ctx.now),
      ],
    );
    const requested = binding.rows[0]?.requested_at;
    challengeBound = Boolean(
      requested &&
      authTime !== null &&
      authTime * 1000 >= requested.getTime() - 1000,
    );
  }
  const bound =
    session ||
    attested ||
    Boolean(opts.linkProof) ||
    challengeBound ||
    subject.authorizationDetails.some(
      (x) =>
        x.type === APPROVAL_DETAIL_TYPE &&
        x.approval_id === a.id &&
        x.operation_digest === a.operation_digest,
    );
  if (!bound) return deny("not_authorized", "challenge_not_bound_to_operation");
  const tokenId = opts.tokenId ?? subject.jti;
  if (!session && !tokenId) return deny("not_authorized", "token_id_required");

  // Serialize each reviewer's counter and session activity across independent approvals.
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `reviewer:${a.tenant_id}:${subject.sub}`,
  ]);
  const velocity = await db.query<{ n: string }>(
    "select count(*) n from authority.approval_decisions v join authority.approvals a on a.id=v.approval_id where a.tenant_id=$1 and v.reviewer_id=$2 and v.decided_at>$3",
    [a.tenant_id, subject.sub, iso(ctx.now - 3600000)],
  );
  if (Number(velocity.rows[0]!.n) >= Number(tier.velocity_per_hour ?? 60))
    return deny("rate_limited", "reviewer_velocity_exceeded");
  // authTime is checked above for every decision except a plain rejection.
  if (session && !plainReject && authTime !== null) {
    const state = await db.query<{ last_seen_at: Date }>(
      "select last_seen_at from authority.reviewer_sessions where tenant_id=$1 and reviewer_id=$2 and jkt=$3 and auth_time=$4 for update",
      [a.tenant_id, subject.sub, subject.dpopJkt ?? "", authTime],
    );
    const seen = state.rows[0]?.last_seen_at;
    const idleMs = idleTimeoutMs(tier);
    if (seen && seen.getTime() < ctx.now - idleMs)
      return deny("not_authorized", "reviewer_session_idle");
    if (!seen && authTime * 1000 < ctx.now - idleMs)
      return deny("not_authorized", "reviewer_session_idle");
    await db.query(
      "insert into authority.reviewer_sessions (tenant_id,reviewer_id,jkt,auth_time,last_seen_at) values ($1,$2,$3,$4,$5) on conflict (tenant_id,reviewer_id,jkt,auth_time) do update set last_seen_at=excluded.last_seen_at",
      [a.tenant_id, subject.sub, subject.dpopJkt ?? "", authTime, iso(ctx.now)],
    );
  }

  const policy = {
    ...ctx.tenant.actions[o.action],
    approverRelation:
      ctx.tenant.actions[o.action]?.approverRelation ??
      o.policy_details?.approverRelation,
    policyVersion:
      o.policy_version ?? ctx.tenant.actions[o.action]?.policyVersion,
  };
  // Approver eligibility and separation of duties were already read above (approverRole),
  // inside the same row locks.

  const fresh =
    session || opts.batchTokenConsumed
      ? { rowCount: 1 }
      : await db.query(
          "insert into authority.used_decision_tokens (tenant_id, jti, approval_id) values ($1,$2,$3) on conflict do nothing returning jti",
          [a.tenant_id, tokenId, a.id],
        );
  if (!fresh.rowCount) return deny("not_authorized", "token_replayed");

  if (challengeBound)
    await db.query(
      "update authority.approval_challenges set used_at=$2 where challenge=$1",
      [subject.approvalChallenge, iso(ctx.now)],
    );
  const approved = input.decision === "approve";
  const assurance = {
    amr: attested ? [...subject.amr, "mfa"] : subject.amr,
    authTime,
    maxAgeSec: maxAge,
    boundTo: session
      ? "session+dpop+decision_digest"
      : challengeBound
        ? "service_challenge+digest"
        : attested
          ? "ciba_request_id"
          : "approval+digest",
    ...(session ? { dpopJkt: subject.dpopJkt } : {}),
    ...(attested ? { attestedBy: "ciba_device_approval" } : {}),
    ...(opts.linkProof ? { approvalMethod: opts.linkProof.method } : {}),
    ...(owner ? { approvedAs: "owner" } : {}),
  };
  const vote = await db.query(
    "insert into authority.approval_decisions (approval_id,reviewer_id,decision,assurance,decision_jti,decided_at) values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning reviewer_id",
    [
      a.id,
      subject.sub,
      input.decision,
      JSON.stringify(assurance),
      tokenId,
      iso(ctx.now),
    ],
  );
  if (!vote.rowCount)
    return deny("operation_conflict", "reviewer_already_decided");
  const votes = await db.query<{ n: string }>(
    "select count(*) n from authority.approval_decisions where approval_id=$1 and decision='approve'",
    [a.id],
  );
  const complete =
    !approved || Number(votes.rows[0]!.n) >= (o.policy_details?.quorum ?? 1);
  await db.query(
    `update authority.approvals set status=$2, approver_id=$3, assurance=$4, decision_jti=$5, decided_at=$6, lease_reviewer_id=null, lease_expires_at=null where id=$1`,
    [
      a.id,
      approved ? (complete ? "approved" : "pending") : "rejected",
      subject.sub,
      JSON.stringify(assurance),
      tokenId,
      iso(ctx.now),
    ],
  );
  if (!approved) await releaseBudgetReservations(db, ctx, o.id);
  if (!approved)
    await db.query(
      "update authority.operations set status='rejected' where id=$1",
      [o.id],
    );
  await bump(db, ctx, "decisions");
  await audit(db, {
    ...base,
    delegationId: o.delegation_id,
    type: approved ? "approval.approved" : "approval.rejected",
    decision: "allow",
    evaluation: {
      permission: a.permission,
      assurance,
      method: a.method,
      operationDigest: a.operation_digest,
      policyVersion: policy.policyVersion,
      ruleIds: o.rule_ids,
      facts: o.facts,
      policyActor: o.actor,
      quorum: o.policy_details?.quorum ?? 1,
      approvalsRecorded: Number(votes.rows[0]!.n),
      ...(input.reason ? { reviewerReason: input.reason } : {}),
    },
  });
  return approvalView((await loadApproval(db, a.id))!);
}

/**
 * Completes a CIBA approval: ask the provider once for the outcome. Pending returns the live
 * approval unchanged. An approved result is verified exactly like a portal decision. If the
 * service crashes after the provider releases the token, the approval simply stays pending and
 * expires: an orphaned grant can never authorize anything else.
 */
export async function pollApproval(
  db: Db,
  ctx: Ctx,
  approvalId: string,
): Promise<
  ApprovalView & {
    polled: "pending" | "approved" | "rejected" | "expired" | "none";
  }
> {
  requirePermission(ctx.caller, "approvals:request");
  const probe = await loadApproval(db, approvalId);
  if (!probe || probe.tenant_id !== ctx.tenant.tenantId) throw notFound();
  const o0 = (await loadOperation(db, probe.operation_id))!;
  if (o0.delegation_id) await loadDelegation(db, o0.delegation_id, "update");
  const o = (await loadOperation(db, o0.id, true))!;
  const a = (await loadApproval(db, approvalId, true))!;
  await requireTrustedBackend(ctx, a.organization_id);
  if (a.method !== "ciba_rar" || !a.ciba_auth_req_id)
    return { ...approvalView(a), polled: "none" };
  if (a.status !== "pending")
    return {
      ...approvalView(a),
      polled:
        a.status === "approved"
          ? "approved"
          : a.status === "rejected"
            ? "rejected"
            : "expired",
    };
  if (a.expires_at.getTime() <= ctx.now) {
    await expire(db, a, o, ctx);
    return {
      ...approvalView((await loadApproval(db, a.id))!),
      polled: "expired",
    };
  }
  const cfg = ctx.tenant.ciba;
  if (!cfg)
    throw new ServiceError("invalid_request", "CIBA is not configured.");
  let result;
  try {
    result = await pollCiba(cfg, a.ciba_auth_req_id);
  } catch (e) {
    if (e instanceof CibaUnavailable)
      throw new ServiceError(
        "authorization_unavailable",
        "The approval channel is unavailable.",
        { dependency: "ciba" },
      );
    throw e;
  }
  if (result.state === "pending")
    return { ...approvalView(a), polled: "pending" };
  if (result.state === "expired") {
    await expire(db, a, o, ctx);
    return {
      ...approvalView((await loadApproval(db, a.id))!),
      polled: "expired",
    };
  }
  if (result.state === "denied") {
    await releaseBudgetReservations(db, ctx, o.id);
    await db.query(
      "update authority.approvals set status='rejected', approver_id=null, reviewer_hint=$2, assurance=$3, decided_at=$4 where id=$1",
      [
        a.id,
        a.reviewer_subject,
        JSON.stringify({ via: "ciba_denied" }),
        iso(ctx.now),
      ],
    );
    await db.query(
      "update authority.operations set status='rejected' where id=$1",
      [o.id],
    );
    await audit(db, {
      type: "approval.rejected",
      tenantId: a.tenant_id,
      organizationId: a.organization_id,
      delegationId: o.delegation_id,
      operationId: o.id,
      approvalId: a.id,
      correlationId: a.correlation_id,
      actor: { kind: "system", id: "ciba-provider" },
      decision: "allow",
      evaluation: {
        method: "ciba_rar",
        via: "ciba_denied",
        reviewerHint: a.reviewer_subject,
        operationDigest: a.operation_digest,
      },
      at: ctx.now,
    });
    return {
      ...approvalView((await loadApproval(db, a.id))!),
      polled: "rejected",
    };
  }
  let subject: Subject;
  try {
    subject = await subjectFromAccessToken(
      ctx.config,
      ctx.tenant,
      result.accessToken,
      ctx.now,
    );
  } catch (e) {
    await audit(db, {
      type: "authorization.denied",
      tenantId: a.tenant_id,
      organizationId: a.organization_id,
      delegationId: o.delegation_id,
      operationId: o.id,
      approvalId: a.id,
      correlationId: a.correlation_id,
      actor: { kind: "system", id: "task-authority" },
      decision: "deny",
      reasonCode: "ciba_token_rejected",
      evaluation: { stage: "approval.ciba" },
      at: ctx.now,
    });
    throw e;
  }
  const view = await recordDecision(
    db,
    ctx,
    a.id,
    subject,
    { decision: "approve", operationDigest: a.operation_digest },
    {
      orgClaimRequired: false,
      channelAttested: cfg.rar === false,
      tokenId: `ciba:${a.ciba_auth_req_id}`,
    },
  );
  return { ...view, polled: "approved" };
}

/** Queue visibility is authorization, checked against current FGA state on every read. */
export async function listApprovals(db: Db, ctx: Ctx, status = "pending") {
  if (ctx.caller.kind !== "user")
    throw new ServiceError("invalid_identity", "A human reviewer is required.");
  if (isAgentSubject(ctx.caller.subject))
    throw new ServiceError("invalid_identity", AGENT_CANNOT_APPROVE);
  if (!["pending", "approved", "rejected", "expired"].includes(status))
    throw new ServiceError("invalid_request");
  const subject = ctx.caller.subject;
  const rows = await db.query<ApprovalRow>(
    `select * from authority.approvals where tenant_id=$1 and organization_id=$2 and status=$3
     and ($3 <> 'pending' or expires_at>$4) order by requested_at,id limit 500`,
    [ctx.tenant.tenantId, subject.orgId, status, iso(ctx.now)],
  );
  const visible = async (a: ApprovalRow): Promise<ApprovalView | null> => {
    const o = await loadOperation(db, a.operation_id);
    if (!o || o.status !== "registered" || o.expires_at.getTime() <= ctx.now)
      return null;
    const d = o.delegation_id
      ? await loadDelegation(db, o.delegation_id)
      : null;
    if (d && delegationStatus(d, ctx.now) !== "active") return null;
    const role = await approverRole(ctx, subject.sub, a.permission, o, d);
    if (!role) return null;
    return { ...approvalView(a, o), viewerRole: role };
  };
  // Per-row lookups run concurrently in bounded chunks; order is preserved.
  const approvals: ApprovalView[] = [];
  for (let at = 0; at < rows.rows.length; at += 25)
    for (const view of await Promise.all(
      rows.rows.slice(at, at + 25).map(visible),
    ))
      if (view) approvals.push(view);
  return { approvals };
}

export async function leaseApproval(
  db: Db,
  ctx: Ctx,
  id: string,
  input: { leaseSec?: number } = {},
) {
  if (ctx.caller.kind !== "user")
    throw new ServiceError("invalid_identity", "A human reviewer is required.");
  if (isAgentSubject(ctx.caller.subject))
    throw new ServiceError("invalid_identity", AGENT_CANNOT_APPROVE);
  const a = await loadApproval(db, id, true);
  const subject = ctx.caller.subject;
  if (
    !a ||
    a.tenant_id !== ctx.tenant.tenantId ||
    a.organization_id !== subject.orgId
  )
    throw new ServiceError("not_authorized", DECISION_DENIED);
  const o = (await loadOperation(db, a.operation_id))!;
  const d = o.delegation_id ? await loadDelegation(db, o.delegation_id) : null;
  if (!(await approverRole(ctx, subject.sub, a.permission, o, d)))
    throw subject.sub === o.initiator_id || subject.sub === d?.actor_id
      ? new ServiceError("approver_ineligible")
      : new ServiceError("not_authorized", DECISION_DENIED);
  if (
    a.status !== "pending" ||
    a.expires_at.getTime() <= ctx.now ||
    o.status !== "registered" ||
    o.expires_at.getTime() <= ctx.now ||
    (d && delegationStatus(d, ctx.now) !== "active")
  )
    throw new ServiceError(
      "operation_conflict",
      "Approval is no longer reviewable.",
    );
  if (
    a.lease_reviewer_id &&
    a.lease_reviewer_id !== subject.sub &&
    a.lease_expires_at &&
    a.lease_expires_at.getTime() > ctx.now
  ) {
    // A lease held by somebody who lost eligibility cannot strand the queue.
    if (
      await fgaCheck(
        ctx.tenant.fga,
        `user:${a.lease_reviewer_id}`,
        a.permission,
        org(a.organization_id),
      )
    )
      throw new ServiceError("operation_conflict", "Approval already leased.");
  }
  const secs = input.leaseSec ?? 120;
  if (!Number.isInteger(secs) || secs < 1 || secs > 300)
    throw new ServiceError(
      "invalid_request",
      "Lease must be between 1 and 300 seconds.",
    );
  const expiresAt = iso(
    Math.min(ctx.now + secs * 1000, a.expires_at.getTime()),
  );
  await db.query(
    "update authority.approvals set lease_reviewer_id=$2,lease_expires_at=$3 where id=$1",
    [id, subject.sub, expiresAt],
  );
  await audit(db, {
    type: "approval.leased",
    tenantId: a.tenant_id,
    organizationId: a.organization_id,
    operationId: o.id,
    approvalId: a.id,
    delegationId: o.delegation_id,
    correlationId: a.correlation_id,
    actor: { kind: "user", id: subject.sub },
    decision: "info",
    evaluation: { expiresAt },
    at: ctx.now,
  });
  return {
    ...approvalView((await loadApproval(db, id))!, o),
    lease: { reviewerId: subject.sub, expiresAt },
  };
}

export async function escalateApproval(
  db: Db,
  ctx: Ctx,
  id: string,
  input: { reviewerSubject: string },
) {
  requirePermission(ctx.caller, "approvals:request");
  const a = await loadApproval(db, id);
  if (!a || a.tenant_id !== ctx.tenant.tenantId) throw notFound();
  if (a.status !== "pending" || a.expires_at.getTime() <= ctx.now)
    throw new ServiceError("operation_conflict");
  if (a.method === "ciba_rar") return approvalView(a);
  if (a.lease_expires_at && a.lease_expires_at.getTime() > ctx.now)
    throw new ServiceError(
      "operation_conflict",
      "A reviewer is currently reviewing this approval.",
    );
  return requestApproval(
    db,
    ctx,
    a.operation_id,
    { reviewerSubject: input.reviewerSubject },
    true,
  );
}

/** A token authorizes exactly this set, and a failed item rolls back every decision. */
export async function decideBatch(
  db: Db,
  ctx: Ctx,
  input: { decisions: Array<Decision & { approvalId: string }> },
) {
  if (ctx.caller.kind !== "user")
    throw new ServiceError("invalid_identity", "A human reviewer is required.");
  const items = input.decisions;
  if (
    !items.length ||
    items.length > 5 ||
    new Set(items.map((x) => x.approvalId)).size !== items.length
  )
    throw new ServiceError(
      "invalid_request",
      "A batch must contain one to five distinct approvals.",
    );
  const subject = ctx.caller.subject;
  if (!subject.jti)
    throw new ServiceError(
      "not_authorized",
      "A single-use decision token is required.",
    );
  const probes = [];
  for (const item of items) {
    const a = await loadApproval(db, item.approvalId);
    if (
      !a ||
      a.tenant_id !== ctx.tenant.tenantId ||
      a.organization_id !== subject.orgId
    )
      throw new ServiceError("not_authorized", DECISION_DENIED);
    const o = (await loadOperation(db, a.operation_id))!;
    const tier = (o.policy_details?.assurance ?? {}) as Record<string, unknown>;
    if (
      tier.assurance === "session_mfa" ||
      Number(tier.batch_max ?? 5) < items.length
    )
      throw new ServiceError(
        "invalid_request",
        "This tier does not support this batch size.",
      );
    if (
      !subject.authorizationDetails.some(
        (x) =>
          x.type === APPROVAL_DETAIL_TYPE &&
          x.approval_id === a.id &&
          x.operation_digest === item.operationDigest,
      )
    )
      throw new ServiceError(
        "not_authorized",
        "Every item must be bound to the decision token.",
      );
    probes.push({ a, o });
  }
  if (new Set(probes.map(({ o }) => o.action)).size !== 1)
    throw new ServiceError(
      "invalid_request",
      "Batch approvals must share an action.",
    );
  // Same lock order as single decisions: delegations, operations, approvals.
  for (const id of [
    ...new Set(
      probes
        .map(({ o }) => o.delegation_id)
        .filter((x): x is string => Boolean(x)),
    ),
  ].sort())
    await loadDelegation(db, id, "update");
  for (const { o } of [...probes].sort((x, y) => x.o.id.localeCompare(y.o.id)))
    await loadOperation(db, o.id, true);
  for (const { a } of [...probes].sort((x, y) => x.a.id.localeCompare(y.a.id)))
    await loadApproval(db, a.id, true);
  await db.query("savepoint approval_batch");
  try {
    const consumed = await db.query(
      "insert into authority.used_decision_tokens (tenant_id,jti,approval_id) values ($1,$2,$3) on conflict do nothing returning jti",
      [ctx.tenant.tenantId, subject.jti, items[0]!.approvalId],
    );
    if (!consumed.rowCount)
      throw new ServiceError(
        "not_authorized",
        "Decision token already consumed.",
      );
    const approvals = [];
    for (const item of items)
      approvals.push(
        await recordDecision(db, ctx, item.approvalId, subject, item, {
          orgClaimRequired: true,
          batchTokenConsumed: true,
        }),
      );
    await db.query("release savepoint approval_batch");
    return { approvals };
  } catch (error) {
    await db.query("rollback to savepoint approval_batch");
    await db.query("release savepoint approval_batch");
    throw error;
  }
}

/** A nonce binds a subsequent fresh step-up to one reviewer, key and operation. */
export async function challengeApproval(db: Db, ctx: Ctx, id: string) {
  if (ctx.caller.kind === "user" && isAgentSubject(ctx.caller.subject))
    throw new ServiceError("invalid_identity", AGENT_CANNOT_APPROVE);
  if (ctx.caller.kind !== "user" || !ctx.caller.subject.dpopJkt)
    throw new ServiceError(
      "not_authorized",
      "A DPoP-bound human reviewer token is required.",
    );
  const subject = ctx.caller.subject;
  const a = await loadApproval(db, id, true);
  if (
    !a ||
    a.tenant_id !== ctx.tenant.tenantId ||
    a.organization_id !== subject.orgId
  )
    throw new ServiceError("not_authorized", DECISION_DENIED);
  const o = (await loadOperation(db, a.operation_id))!;
  const d = o.delegation_id ? await loadDelegation(db, o.delegation_id) : null;
  if (!(await approverRole(ctx, subject.sub, a.permission, o, d)))
    throw subject.sub === o.initiator_id || subject.sub === d?.actor_id
      ? new ServiceError("approver_ineligible")
      : new ServiceError("not_authorized", DECISION_DENIED);
  if (
    a.status !== "pending" ||
    a.expires_at.getTime() <= ctx.now ||
    o.status !== "registered"
  )
    throw new ServiceError("operation_conflict");
  const challenge = randomBytes(32).toString("base64url");
  const expiresAt = iso(Math.min(ctx.now + 300000, a.expires_at.getTime()));
  await db.query(
    "insert into authority.approval_challenges (challenge,tenant_id,approval_id,operation_digest,reviewer_id,jkt,requested_at,expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      challenge,
      a.tenant_id,
      a.id,
      a.operation_digest,
      subject.sub,
      subject.dpopJkt,
      iso(ctx.now),
      expiresAt,
    ],
  );
  return { challenge, expiresAt };
}
