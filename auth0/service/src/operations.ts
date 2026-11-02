import {
  CANONICAL_VERSION,
  type ApprovalRequirement,
  type AuditEntry,
  type OperationView,
  type RegisterOperation,
} from "@task-authority/contracts";
import { audit, auditView } from "./audit.js";
import { requirePermission, requireUserGrant } from "./authn.js";
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
import { bump } from "./usage.js";
import {
  applyRequirementFloor,
  callerAssuranceSatisfied,
  budgetAvailability,
  evaluatePolicy,
  loadPolicy,
  policyActor,
  reserveBudgets,
  releaseBudgetReservations,
  shadowEvaluation,
} from "./policies.js";
import { ServiceError } from "./errors.js";
import { fgaCheck } from "./fga.js";
import { iso, type ClaimRow, type Db, type OperationRow } from "./store.js";

/**
 * Canonical form v1: sorted object keys, no insignificant whitespace, integers
 * only (money is integer minor units; use strings for anything else).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new ServiceError(
        "invalid_request",
        "Arguments may only contain safe integers; use integer minor units or strings.",
      );
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
      .join(",")}}`;
  }
  throw new ServiceError("invalid_request", "Unsupported argument value.");
}

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return `sha256:${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function canonicalDocument(p: {
  tenantId: string;
  organizationId: string;
  delegationId: string | null;
  operationKey: string;
  action: string;
  scope: string;
  resource: string;
  arguments: Record<string, unknown>;
  resourceServer?: string;
  businessStateVersion: string | null;
}) {
  return canonicalize({ v: CANONICAL_VERSION, ...p });
}

export async function operationView(
  db: Db,
  o: OperationRow,
  now: number,
): Promise<OperationView> {
  const a = await db.query(
    "select id, status, expires_at from authority.approvals where operation_id=$1 order by (status in ('pending','approved')) desc, requested_at desc, id desc limit 1",
    [o.id],
  );
  const c = await db.query<ClaimRow>(
    "select id, status from authority.claims where operation_id=$1 order by seq desc limit 1",
    [o.id],
  );
  const owner =
    o.policy_details?.selfApproval === "owner" && o.delegation_id
      ? await db.query<{ owner_type: string }>(
          "select owner_type from authority.delegations where id=$1",
          [o.delegation_id],
        )
      : null;
  return {
    id: o.id,
    tenantId: o.tenant_id,
    organizationId: o.organization_id,
    delegationId: o.delegation_id,
    resourceServer: o.resource_server,
    outcomeStatus:
      o.decision === "deny"
        ? "denied"
        : o.status === "rejected"
          ? "rejected"
          : o.status === "cancelled"
            ? "failed"
            : o.decision === "step_up_required"
              ? "step_up_required"
              : c.rows[0]?.status === "succeeded"
                ? "completed"
                : c.rows[0]?.status === "failed"
                  ? "failed"
                  : a.rows[0]?.status === "approved"
                    ? "approved"
                    : o.approval_requirement === "human"
                      ? "pending_approval"
                      : "approved",
    operationKey: o.operation_key,
    taskId: o.task_id,
    action: o.action,
    resource: o.resource,
    arguments: o.arguments,
    canonicalVersion: o.canonical_version,
    digest: o.digest,
    approvalRequirement: o.approval_requirement,
    decision: o.decision,
    reasonCode: o.reason_code,
    policyVersion: o.policy_version,
    ruleIds: o.rule_ids,
    tier: o.policy_details?.tier,
    assurance: o.policy_details?.assurance,
    stepUp: o.policy_details?.stepUp,
    actor: o.actor,
    facts: o.facts,
    status: o.status,
    businessStateVersion: o.business_state_version,
    expiresAt: iso(o.expires_at),
    correlationId: o.correlation_id,
    approvalId: a.rows[0]?.id ?? null,
    // A lapsed window is reported as expired even before anything has touched the row.
    approvalStatus: a.rows[0]
      ? ["pending", "approved"].includes(a.rows[0].status) &&
        a.rows[0].expires_at.getTime() <= now
        ? "expired"
        : a.rows[0].status
      : null,
    claim: c.rows[0] ? { id: c.rows[0].id, status: c.rows[0].status } : null,
    // The delegating user may approve this operation themselves (with a passkey).
    ownerApproval:
      owner?.rows[0]?.owner_type === "user" &&
      (o.policy_details?.quorum ?? 1) === 1,
  };
}

export async function loadOperation(db: Db, id: string, lock = false) {
  const r = await db.query<OperationRow>(
    `select * from authority.operations where id=$1 ${lock ? "for update" : ""}`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function registerOperation(
  db: Db,
  ctx: Ctx,
  input: RegisterOperation,
): Promise<OperationView> {
  const caller = ctx.caller;
  if (caller.kind === "service")
    requirePermission(caller, "operations:register");
  else requireUserGrant(caller, "operations:register");
  const d = input.delegationId
    ? await loadDelegation(db, input.delegationId, "share")
    : null;
  if (input.delegationId && (!d || d.tenant_id !== ctx.tenant.tenantId))
    throw new ServiceError("delegation_not_found", "Delegation not found.");
  const subject = caller.subject;
  if (!d && !subject)
    throw new ServiceError(
      "invalid_identity",
      "Human-direct registration requires a verified human subject.",
    );
  if (!d && policyActor(ctx, false).type !== "human")
    throw new ServiceError(
      "not_authorized",
      "Human-direct registration requires a human actor.",
    );
  const organizationId =
    d?.organization_id ?? input.organizationId ?? subject?.orgId;
  if (!organizationId || (!d && subject?.orgId !== organizationId))
    throw new ServiceError("not_authorized", "Verified organization required.");
  if (caller.kind === "service")
    await requireTrustedBackend(ctx, organizationId);
  const scope = d?.resource ?? input.resourceServer;
  if (!scope)
    throw new ServiceError(
      "invalid_request",
      "Human-direct registration requires resourceServer.",
    );
  const resourceServer = input.resourceServer ?? scope;
  const floor = ctx.tenant.actions[input.action];
  const chain = ctx.correlationSupplied
    ? ctx.correlationId
    : (d?.correlation_id ?? ctx.correlationId);
  const actor = policyActor(ctx, !!d);
  if (!subject && d?.owner_type === "user") actor.id = d.actor_id;
  const facts = input.facts ?? {},
    assertion = input.approvalAssertion ?? "none";
  const base = {
    tenantId: ctx.tenant.tenantId,
    organizationId,
    delegationId: d?.id ?? null,
    correlationId: chain,
    actor: actorOf(ctx),
    at: ctx.now,
  };
  // A human-direct caller names the resource server, so it would also choose the policy,
  // relations, budgets and tiers. Only the operator's action entry may authorise that choice.
  if (!d) {
    const refusal = !floor
      ? "action_not_configured"
      : !floor.resourceServers?.includes(resourceServer)
        ? "resource_server_not_allowed"
        : null;
    if (refusal) {
      await audit(db, {
        ...base,
        type: "authorization.denied",
        decision: "deny",
        reasonCode: refusal,
        evaluation: {
          stage: "operation.register",
          action: input.action,
          facts,
          actor,
          resourceServer,
        },
      });
      throw new ServiceError(
        "not_authorized",
        "Operation was not registered.",
        {
          reason: refusal,
        },
      );
    }
  }
  const canonical = canonicalDocument({
    tenantId: ctx.tenant.tenantId,
    organizationId,
    delegationId: d?.id ?? null,
    operationKey: input.operationKey,
    action: input.action,
    scope,
    resource: input.resource,
    arguments: input.arguments,
    businessStateVersion: input.businessStateVersion ?? null,
    ...(input.resourceServer ? { resourceServer: input.resourceServer } : {}),
  });
  const digest = await sha256(canonical);
  // Serialize registrations for one logical operation before testing reservations.
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${ctx.tenant.tenantId}:${organizationId}:${input.operationKey}`,
  ]);
  const existing = await db.query<OperationRow>(
    "select * from authority.operations where tenant_id=$1 and organization_id=$2 and operation_key=$3 for update",
    [ctx.tenant.tenantId, organizationId, input.operationKey],
  );
  if (existing.rows[0]) {
    const e = existing.rows[0];
    if (canonicalize(e.actor) !== canonicalize(actor))
      throw new ServiceError(
        "not_authorized",
        "Operation key belongs to a different verified actor.",
      );
    if (subject && e.initiator_id !== subject.sub)
      throw new ServiceError(
        "not_authorized",
        "Operation key belongs to a different initiator.",
      );
    if (d && delegationStatus(d, ctx.now) !== "active")
      throw new ServiceError(
        delegationStatus(d, ctx.now) === "revoked"
          ? "delegation_revoked"
          : "delegation_expired",
        "Delegation is no longer active.",
      );
    if (subject) {
      const relation =
        floor?.requesterRelation ?? e.policy_details.requesterRelation;
      if (
        !relation ||
        !(await fgaCheck(
          ctx.tenant.fga,
          `user:${subject.sub}`,
          relation,
          org(organizationId),
        ))
      )
        throw new ServiceError(
          "not_authorized",
          "Initiator permission is no longer active.",
        );
    }
    if (
      e.digest === digest &&
      e.resource_server === resourceServer &&
      e.approval_assertion === assertion &&
      canonicalize(e.facts) === canonicalize(facts)
    ) {
      if (
        e.decision === "step_up_required" &&
        e.status === "registered" &&
        e.policy_details.stepUp &&
        subject?.sub === e.initiator_id &&
        callerAssuranceSatisfied(ctx, e.policy_details.stepUp)
      ) {
        if (
          e.expires_at.getTime() <= ctx.now ||
          (d && delegationStatus(d, ctx.now) !== "active")
        )
          throw new ServiceError(
            "operation_expired",
            "Operation or delegation expired before caller step-up.",
          );
        const currentRelation =
          ctx.tenant.actions[e.action]?.requesterRelation ??
          e.policy_details.requesterRelation;
        if (
          !currentRelation ||
          !(await fgaCheck(
            ctx.tenant.fga,
            `user:${subject.sub}`,
            currentRelation,
            org(e.organization_id),
          ))
        )
          throw new ServiceError(
            "not_authorized",
            "Caller permission is no longer active.",
          );
        const pinned = e.policy_version
          ? await loadPolicy(
              db,
              e.tenant_id,
              e.resource_server,
              e.policy_version,
            )
          : null;
        let next = {
          ...e.policy_details,
          decision: "allow" as const,
          reasonCode: "caller_assurance_satisfied",
        };
        let bindings: Awaited<
          ReturnType<typeof budgetAvailability>
        >["bindings"] = [];
        if (pinned && next.budgetRuleIds.length) {
          const available = await budgetAvailability(
            db,
            ctx,
            pinned,
            e.action,
            next.budgetRuleIds,
            {
              delegationId: e.delegation_id,
              principal: e.initiator_id ?? e.actor.id,
              organizationId: e.organization_id,
            },
            e.arguments,
            true,
            e.id,
          );
          if (available.exhausted.size)
            next = applyRequirementFloor(
              ctx,
              pinned,
              e.action,
              e.arguments,
              e.approval_assertion,
              evaluatePolicy(
                pinned,
                e.action,
                {
                  action: e.action,
                  resource: e.resource,
                  args: e.arguments,
                  facts: e.facts,
                  actor: e.actor,
                  relations: e.policy_details.relationInputs ?? {},
                  aggregates: {},
                },
                available.exhausted,
              ),
            ) as typeof next;
          bindings = available.bindings.filter(
            (b) => !available.exhausted.has(b.ruleId),
          );
        }
        await db.query(
          "update authority.operations set decision=$2,reason_code=$3,policy_details=$4,rule_ids=$5,approval_requirement=$6 where id=$1",
          [
            e.id,
            next.decision,
            next.reasonCode,
            JSON.stringify(next),
            next.ruleIds,
            (next.decision as string) === "approval_required"
              ? "human"
              : "none",
          ],
        );
        if (pinned && next.decision === "allow")
          await reserveBudgets(db, ctx, pinned, e.id, bindings);
        await audit(db, {
          ...base,
          operationId: e.id,
          type:
            (next.decision as string) === "deny"
              ? "authorization.denied"
              : "authorization.allowed",
          decision: (next.decision as string) === "deny" ? "deny" : "allow",
          reasonCode: next.reasonCode,
          evaluation: {
            stage: "operation.register.step_up",
            policyVersion: e.policy_version,
            ruleIds: next.ruleIds,
            actor: e.actor,
            facts: e.facts,
          },
        });
        return operationView(db, (await loadOperation(db, e.id))!, ctx.now);
      }
      return operationView(db, e, ctx.now);
    }
    throw new ServiceError(
      "operation_conflict",
      "Operation key is already bound to different protected arguments or facts.",
      { operationId: e.id },
    );
  }
  const p = await loadPolicy(db, ctx.tenant.tenantId, resourceServer);
  const relations: Record<string, boolean> = {};
  const referenced = [
    ...new Set(
      (p?.actions[input.action]?.rules ?? []).flatMap((r) =>
        [...r.when.matchAll(/\brelations\.([A-Za-z_]\w*)/g)].map((m) => m[1]!),
      ),
    ),
  ];
  for (const relation of referenced)
    relations[relation] = await fgaCheck(
      ctx.tenant.fga,
      subject
        ? `user:${subject.sub}`
        : d
          ? `agent:${d.agent_id}`
          : `client:${caller.kind === "service" ? caller.clientId : actor.id}`,
      relation,
      org(organizationId),
    );
  const inputs = {
    action: input.action,
    resource: input.resource,
    args: input.arguments,
    facts,
    actor,
    relations,
    aggregates: {},
  };
  let decision = evaluatePolicy(p, input.action, inputs);
  const deny = async (
    code: ConstructorParameters<typeof ServiceError>[0],
    reason: string,
    extra: Record<string, unknown> = {},
  ) => {
    await audit(db, {
      ...base,
      type: "authorization.denied",
      decision: "deny",
      reasonCode: reason,
      evaluation: {
        stage: "operation.register",
        action: input.action,
        policyVersion: decision.policyVersion,
        ruleIds: decision.ruleIds,
        facts,
        actor,
        ...extra,
      },
    });
    throw new ServiceError(code, "Operation was not registered.", {
      reason,
      ...extra,
    });
  };
  if (d) {
    const status = delegationStatus(d, ctx.now);
    if (status === "revoked")
      return deny("delegation_revoked", "delegation_revoked");
    if (status === "expired")
      return deny("delegation_expired", "delegation_expired");
    if (!d.actions.includes(input.action))
      return deny("not_authorized", "action_outside_delegation");
    if (
      d.resource_prefixes &&
      !d.resource_prefixes.some((p) => input.resource.startsWith(p))
    )
      return deny("not_authorized", "resource_outside_delegation");
    for (const [field, max] of Object.entries(d.ceilings)) {
      const v = input.arguments[field];
      // Fail closed: a ceiling field sent as a string ("999999"), a fraction or an object
      // cannot be compared, so it is refused instead of slipping past the bound.
      if (v !== undefined && (!Number.isSafeInteger(v) || (v as number) > max))
        return deny("not_authorized", "delegation_ceiling_exceeded", { field });
    }
  }
  if (subject) {
    if (d?.owner_type === "user" && subject.sub !== d.actor_id)
      return deny("not_authorized", "subject_is_not_delegation_owner");
    const relation = floor?.requesterRelation ?? decision.requesterRelation;
    if (
      !relation ||
      !(await fgaCheck(
        ctx.tenant.fga,
        `user:${subject.sub}`,
        relation,
        org(organizationId),
      ))
    )
      return deny("not_authorized", "initiator_lacks_permission");
  }
  const initiator =
    subject?.sub ?? (d?.owner_type === "user" ? d.actor_id : null);
  let bindings: Awaited<ReturnType<typeof budgetAvailability>>["bindings"] = [];
  if (p && decision.decision !== "deny" && decision.budgetRuleIds.length) {
    const available = await budgetAvailability(
      db,
      ctx,
      p,
      input.action,
      decision.budgetRuleIds,
      {
        delegationId: d?.id ?? null,
        principal: initiator ?? actor.id,
        organizationId,
      },
      input.arguments,
      true,
    );
    decision = evaluatePolicy(p, input.action, inputs, available.exhausted);
    bindings = available.bindings.filter(
      (b) => !available.exhausted.has(b.ruleId),
    );
  }
  decision = applyRequirementFloor(
    ctx,
    p,
    input.action,
    input.arguments,
    assertion,
    decision,
  );
  if (decision.decision === "step_up_required") {
    const needed = decision.stepUp!;
    if (callerAssuranceSatisfied(ctx, needed))
      decision = {
        ...decision,
        decision: "allow",
        reasonCode: "caller_assurance_satisfied",
      };
    else if (!subject)
      decision = {
        ...decision,
        decision: "approval_required",
        tier: "routine",
        assurance: p?.tiers.routine,
        quorum: 1,
        reasonCode: "noninteractive_approval_required",
      };
  }
  decision = { ...decision, relationInputs: relations };
  const requirement: ApprovalRequirement =
    decision.decision === "approval_required" ? "human" : "none";
  const expires = Math.min(
    ctx.now + ctx.tenant.defaults.operationTtlSec * 1000,
    d?.expires_at.getTime() ?? Infinity,
    input.expiresAt ? Date.parse(input.expiresAt) : Infinity,
  );
  if (expires <= ctx.now) return deny("operation_expired", "operation_expired");
  const id = ctx.newId("op");
  await db.query(
    `insert into authority.operations
    (id,tenant_id,organization_id,delegation_id,operation_key,task_id,action,resource,scope,arguments,canonical_version,canonical,digest,business_state_version,approval_assertion,approval_requirement,initiator_id,correlation_id,status,created_at,expires_at,facts,actor,policy_version,rule_ids,decision,reason_code,policy_details,resource_server)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'registered',$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
    [
      id,
      ctx.tenant.tenantId,
      organizationId,
      d?.id ?? null,
      input.operationKey,
      input.taskId ?? null,
      input.action,
      input.resource,
      scope,
      JSON.stringify(input.arguments),
      CANONICAL_VERSION,
      canonical,
      digest,
      input.businessStateVersion ?? null,
      assertion,
      requirement,
      initiator,
      chain,
      iso(ctx.now),
      iso(expires),
      JSON.stringify(facts),
      JSON.stringify(actor),
      decision.policyVersion,
      decision.ruleIds,
      decision.decision,
      decision.reasonCode,
      JSON.stringify(decision),
      resourceServer,
    ],
  );
  if (p && decision.decision === "allow")
    await reserveBudgets(db, ctx, p, id, bindings);
  await bump(db, ctx, "operations");
  await audit(db, {
    ...base,
    operationId: id,
    type:
      decision.decision === "deny"
        ? "authorization.denied"
        : "operation.registered",
    decision: decision.decision === "deny" ? "deny" : "allow",
    reasonCode: decision.reasonCode,
    evaluation: {
      stage: "operation.register",
      action: input.action,
      digest,
      canonicalVersion: CANONICAL_VERSION,
      customerApprovalPolicy: assertion,
      approvalRequirement: requirement,
      requirementRaisedByTenantGuard: requirement !== assertion,
      policyVersion: decision.policyVersion,
      ruleIds: decision.ruleIds,
      actor,
      facts,
      decision: decision.decision,
      taskId: input.taskId ?? null,
    },
  });
  await shadowEvaluation(
    db,
    ctx,
    resourceServer,
    input.action,
    { ...inputs, approvalAssertion: assertion },
    {
      ...base,
      operationId: id,
    },
  );
  return operationView(db, (await loadOperation(db, id))!, ctx.now);
}

async function visible(db: Db, ctx: Ctx, id: string, permission: string) {
  const o = await loadOperation(db, id);
  if (!o) throw notFound();
  const d = o.delegation_id ? await loadDelegation(db, o.delegation_id) : null;
  if (
    !(await canRead(
      ctx,
      db,
      o,
      [o.initiator_id, d?.actor_id ?? null],
      permission,
      ctx.tenant.actions[o.action]?.approverRelation ??
        o.policy_details?.approverRelation,
    ))
  )
    throw notFound();
  return o;
}

export async function getOperation(db: Db, ctx: Ctx, id: string) {
  return operationView(
    db,
    await visible(db, ctx, id, "operations:read"),
    ctx.now,
  );
}

export async function listAudit(
  db: Db,
  ctx: Ctx,
  id: string,
): Promise<AuditEntry[]> {
  const o = await visible(db, ctx, id, "audit:read");
  // Humans need investigator rights for audit; service callers need audit:read.
  if (ctx.caller.kind === "user") {
    const ok = await fgaCheck(
      ctx.tenant.fga,
      `user:${ctx.caller.subject.sub}`,
      "investigator",
      org(o.organization_id),
    );
    if (!ok) throw notFound();
  }
  const r = await db.query(
    `select * from authority.audit_events
      where tenant_id=$1 and (operation_id=$2 or (delegation_id=$3 and operation_id is null))
      order by id`,
    [o.tenant_id, o.id, o.delegation_id],
  );
  return r.rows.map(auditView);
}

export async function cancelOperation(
  db: Db,
  ctx: Ctx,
  id: string,
  reason?: string,
) {
  requirePermission(ctx.caller, "operations:cancel");
  const probe = await loadOperation(db, id);
  if (!probe || probe.tenant_id !== ctx.tenant.tenantId) throw notFound();
  if (probe.delegation_id)
    await loadDelegation(db, probe.delegation_id, "update"); // delegation → operation lock order
  const o = (await loadOperation(db, id, true))!;
  await requireTrustedBackend(ctx, o.organization_id);
  const claim = await db.query<ClaimRow>(
    "select * from authority.claims where operation_id=$1 and status <> 'released' limit 1",
    [o.id],
  );
  const inFlight =
    claim.rows[0] &&
    ["claimed", "pending", "unknown"].includes(claim.rows[0].status);
  if (o.status === "registered") {
    await releaseBudgetReservations(db, ctx, o.id);
    await db.query(
      "update authority.operations set status='cancelled' where id=$1",
      [o.id],
    );
    await db.query(
      "update authority.approvals set status='expired' where operation_id=$1 and status='pending'",
      [o.id],
    );
    await audit(db, {
      type: "operation.cancelled",
      tenantId: o.tenant_id,
      organizationId: o.organization_id,
      delegationId: o.delegation_id,
      operationId: o.id,
      correlationId: o.correlation_id,
      actor: actorOf(ctx),
      decision: "info",
      reasonCode: reason ?? "cancelled_before_claim",
      at: ctx.now,
    });
  }
  const view = await operationView(db, (await loadOperation(db, id))!, ctx.now);
  // Honest semantics: after a claim the external call may already be running.
  return {
    operation: view,
    cancelled: view.status === "cancelled",
    inFlightOrUnknown: Boolean(inFlight),
  };
}

export type AuditQuery = {
  correlationId?: string;
  operationId?: string;
  delegationId?: string;
  type?: string;
  reason?: string;
  limit: number;
  after?: number;
};

/**
 * Investigator view across a tenant. Service callers need audit:read (tenant-wide);
 * human callers need the FGA `investigator` relation and only see their own organization.
 */
export async function queryAudit(db: Db, ctx: Ctx, q: AuditQuery) {
  let orgFilter: string | null = null;
  if (ctx.caller.kind === "service") {
    requirePermission(ctx.caller, "audit:read");
  } else {
    const s = ctx.caller.subject;
    if (!s.orgId) throw notFound();
    if (
      !(await fgaCheck(
        ctx.tenant.fga,
        `user:${s.sub}`,
        "investigator",
        org(s.orgId),
      ))
    )
      throw notFound();
    orgFilter = s.orgId;
  }
  const where = ["tenant_id = $1"];
  const args: unknown[] = [ctx.tenant.tenantId];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace("?", `$${args.length}`));
  };
  if (orgFilter) add("organization_id = ?", orgFilter);
  if (q.correlationId) add("correlation_id = ?", q.correlationId);
  if (q.operationId) add("operation_id = ?", q.operationId);
  if (q.delegationId) add("delegation_id = ?", q.delegationId);
  if (q.type) add("type = ?", q.type);
  if (q.reason) add("reason_code = ?", q.reason);
  if (q.after) add("id > ?", q.after);
  args.push(q.limit + 1);
  const r = await db.query(
    `select * from authority.audit_events where ${where.join(" and ")} order by id limit $${args.length}`,
    args,
  );
  const rows = r.rows.slice(0, q.limit);
  return {
    events: rows.map(auditView),
    next: r.rows.length > q.limit ? Number(rows[rows.length - 1].id) : null,
  };
}
