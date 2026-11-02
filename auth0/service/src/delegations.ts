import type {
  CreateDelegation,
  DelegationView,
} from "@task-authority/contracts";
import { audit } from "./audit.js";
import { requirePermission } from "./authn.js";
import {
  actorOf,
  canRead,
  delegationStatus,
  delegationView,
  notFound,
  org,
  requireTrustedBackend,
  type Ctx,
} from "./context.js";
import { ServiceError } from "./errors.js";
import { fgaCheck } from "./fga.js";
import { bump } from "./usage.js";
import { iso, type Db, type DelegationRow } from "./store.js";

export async function createDelegation(
  db: Db,
  ctx: Ctx,
  input: CreateDelegation,
): Promise<DelegationView> {
  const caller = requirePermission(ctx.caller, "delegations:create");
  if (caller.kind !== "service") throw new Error("unreachable");
  const grantor = caller.subject;
  // The grantor is only ever a verified token subject, never a request field.
  if (!grantor)
    throw new ServiceError(
      "invalid_identity",
      "A verified grantor subject token is required.",
    );
  const base = {
    tenantId: ctx.tenant.tenantId,
    organizationId: input.organizationId,
    correlationId: ctx.correlationId,
    actor: { kind: "user" as const, id: grantor.sub },
    at: ctx.now,
  };
  const deny = async (
    code: ConstructorParameters<typeof ServiceError>[0],
    reason: string,
  ) => {
    await audit(db, {
      ...base,
      type: "authorization.denied",
      decision: "deny",
      reasonCode: reason,
      evaluation: {
        stage: "delegation.create",
        ownerType: input.ownerType,
        agentId: input.agentId,
      },
    });
    throw new ServiceError(code, "Delegation was not created.", { reason });
  };
  // A forwarded token carrying `act` or sub_profile=ai_agent is an agent acting for the
  // person; it cannot grant authority in their name.
  if (grantor.actorType === "agent")
    return deny("invalid_identity", "grantor_must_be_human");
  if (grantor.orgId && grantor.orgId !== input.organizationId)
    return deny("not_authorized", "grantor_org_mismatch");
  const expires = Date.parse(input.expiresAt);
  if (!(expires > ctx.now))
    throw new ServiceError(
      "invalid_request",
      "expiresAt must be in the future.",
    );
  if (expires - ctx.now > ctx.tenant.defaults.delegationMaxTtlSec * 1000)
    throw new ServiceError(
      "invalid_request",
      "Delegation exceeds the tenant maximum lifetime.",
      {
        maxTtlSec: ctx.tenant.defaults.delegationMaxTtlSec,
      },
    );
  for (const a of input.actions)
    if (!ctx.tenant.actions[a])
      throw new ServiceError(
        "invalid_request",
        "Unknown action for this tenant.",
        { action: a },
      );

  try {
    await requireTrustedBackend(ctx, input.organizationId);
  } catch (e) {
    if (e instanceof ServiceError && e.code === "not_authorized")
      return deny("not_authorized", "backend_not_trusted_for_org");
    throw e;
  }
  const fga = ctx.tenant.fga;
  const user = `user:${grantor.sub}`;
  if (
    !(await fgaCheck(
      fga,
      `agent:${input.agentId}`,
      "registered_agent",
      org(input.organizationId),
    ))
  )
    return deny("not_authorized", "agent_not_registered_for_org");
  if (input.ownerType === "organization") {
    // Org-owned authority can only be issued by an organizational grantor.
    if (
      !(await fgaCheck(
        fga,
        user,
        "delegation_grantor",
        org(input.organizationId),
      ))
    )
      return deny("not_authorized", "not_org_delegation_grantor");
  }
  for (const a of input.actions) {
    const rel = ctx.tenant.actions[a]!.requesterRelation;
    // A user can only delegate what the user can currently do (user-owned),
    // and an org grantor may only grant actions the org policy defines.
    if (
      input.ownerType === "user" &&
      !(await fgaCheck(fga, user, rel, org(input.organizationId)))
    )
      return deny("not_authorized", "grantor_lacks_permission");
  }
  const open = await db.query<{ n: string }>(
    "select count(*) n from authority.delegations where tenant_id=$1 and revoked_at is null and expires_at > $2",
    [ctx.tenant.tenantId, iso(ctx.now)],
  );
  if (Number(open.rows[0]!.n) >= ctx.tenant.quotas.openDelegations)
    throw new ServiceError("quota_exceeded", "Open delegation quota reached.");

  const id = ctx.newId("dlg");
  await db.query(
    `insert into authority.delegations
     (id, tenant_id, organization_id, owner_type, actor_id, agent_id, resource, actions,
      resource_prefixes, ceilings, reason, provenance, policy_ref, correlation_id, created_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id,
      ctx.tenant.tenantId,
      input.organizationId,
      input.ownerType,
      grantor.sub,
      input.agentId,
      input.resource,
      input.actions,
      input.resourcePrefixes ?? null,
      JSON.stringify(input.ceilings ?? {}),
      input.reason ?? null,
      JSON.stringify({
        grantorSource: "subject_token",
        issuer: ctx.tenant.issuer,
        callerClient: caller.clientId,
        grantorAssurance: grantor.amr,
      }),
      `fga:${input.ownerType}`,
      ctx.correlationId,
      iso(ctx.now),
      iso(expires),
    ],
  );
  await bump(db, ctx, "delegations");
  await audit(db, {
    ...base,
    type: "delegation.created",
    delegationId: id,
    decision: "allow",
    evaluation: {
      ownerType: input.ownerType,
      agentId: input.agentId,
      actions: input.actions,
      expiresAt: iso(expires),
      callerClient: caller.clientId,
    },
  });
  const row = await loadDelegation(db, id);
  return delegationView(row!, ctx.now);
}

export async function loadDelegation(
  db: Db,
  id: string,
  lock?: "update" | "share",
) {
  const r = await db.query<DelegationRow>(
    `select * from authority.delegations where id = $1 ${lock === "update" ? "for update" : lock === "share" ? "for share" : ""}`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function getDelegation(db: Db, ctx: Ctx, id: string) {
  const d = await loadDelegation(db, id);
  if (
    !d ||
    !(await canRead(
      ctx,
      db,
      d,
      [d.actor_id],
      "delegations:read",
      "delegation_grantor",
    ))
  )
    throw new ServiceError("delegation_not_found", "Delegation not found.");
  return delegationView(d, ctx.now);
}

/**
 * Revocation takes the delegation row lock, the same lock every claim holds, so
 * revoke and claim serialize. Claimed-but-unsettled operations are reported as
 * in flight: revocation cannot recall an external call that may have started.
 */
export async function revokeDelegation(
  db: Db,
  ctx: Ctx,
  id: string,
  reason?: string,
): Promise<DelegationView> {
  const d = await loadDelegation(db, id, "update");
  if (!d || d.tenant_id !== ctx.tenant.tenantId) throw notFound();
  let actor = actorOf(ctx);
  let allowed = false;
  if (ctx.caller.kind === "service") {
    // Revocation only ever reduces authority, so a trusted backend may revoke
    // authority it manages (e.g. on task cancellation).
    allowed = ctx.caller.permissions.has("delegations:revoke");
    if (allowed) await requireTrustedBackend(ctx, d.organization_id);
    if (ctx.caller.subject)
      actor = { kind: "user", id: ctx.caller.subject.sub } as typeof actor;
  } else {
    const s = ctx.caller.subject;
    const user = `user:${s.sub}`;
    allowed =
      (!s.orgId || s.orgId === d.organization_id) &&
      (s.sub === d.actor_id ||
        (await fgaCheck(
          ctx.tenant.fga,
          user,
          "admin",
          org(d.organization_id),
        )));
  }
  if (!allowed) throw notFound();
  const inFlight = await db.query<{ id: string }>(
    `select o.id from authority.operations o
       join authority.claims c on c.operation_id = o.id
      where o.delegation_id = $1 and c.status in ('claimed','pending','unknown')`,
    [d.id],
  );
  if (!d.revoked_at) {
    await db.query(
      "update authority.delegations set revoked_at=$2, revoked_by=$3, revoke_reason=$4 where id=$1",
      [d.id, iso(ctx.now), actor.id, reason ?? null],
    );
    await audit(db, {
      type: "delegation.revoked",
      tenantId: d.tenant_id,
      organizationId: d.organization_id,
      delegationId: d.id,
      correlationId: d.correlation_id,
      actor,
      decision: "info",
      reasonCode: reason ? "revoked_with_reason" : "revoked",
      evaluation: { inFlightOperations: inFlight.rows.map((r) => r.id) },
      at: ctx.now,
    });
  }
  const fresh = (await loadDelegation(db, id))!;
  return {
    ...delegationView(fresh, ctx.now),
    inFlightOperations: inFlight.rows.map((r) => r.id),
  };
}

export { delegationStatus };
