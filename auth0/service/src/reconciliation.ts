import { requirePermission } from "./authn.js";
import { audit } from "./audit.js";
import { actorOf, requireTrustedBackend, type Ctx } from "./context.js";
import { ServiceError } from "./errors.js";
import { iso, type Db } from "./store.js";

export type ProviderEvent = {
  organizationId: string;
  providerReference: string;
  claimId?: string;
  amountMinor?: number;
  currency?: string;
  action: string;
  resource: string;
};

/** Called by a backend which has verified its provider webhook signature. */
export async function reconcileProviderEvent(
  db: Db,
  ctx: Ctx,
  input: ProviderEvent,
) {
  requirePermission(ctx.caller, "provider-events:write");
  await requireTrustedBackend(ctx, input.organizationId);
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${ctx.tenant.tenantId}|provider|${input.providerReference}`,
  ]);
  const prior = await db.query(
    "select * from authority.provider_events where tenant_id=$1 and provider_reference=$2",
    [ctx.tenant.tenantId, input.providerReference],
  );
  if (prior.rows[0]) {
    const p = prior.rows[0];
    if (
      p.organization_id !== input.organizationId ||
      p.action !== input.action ||
      p.resource !== input.resource
    )
      throw new ServiceError(
        "operation_conflict",
        "Provider reference was already recorded with different parameters.",
      );
    return {
      providerReference: input.providerReference,
      matched: p.claim_id !== null,
      claimId: p.claim_id,
      bypassDetected: p.claim_id === null,
    };
  }
  const claim = await db.query(
    `select c.id, c.operation_id, c.delegation_id, c.correlation_id
     from authority.claims c join authority.operations o on o.id=c.operation_id
     where c.tenant_id=$1 and c.organization_id=$2 and o.action=$3 and o.resource=$4
       and c.status <> 'released'
       and (c.outcome->>'providerReference' is null or c.outcome->>'providerReference'=$6)
       and ($3 <> 'refund:create' or c.outcome->>'providerReference'=$6
         or ($7::bigint is not null and $8::text is not null
           and coalesce(o.arguments->>'amountMinor',o.arguments->>'amount_minor')=$7::text
           and upper(o.arguments->>'currency')=upper($8)))
       and (($5::text is not null and c.id=$5) or c.outcome->>'providerReference'=$6)
     order by c.minted_at desc limit 1 for update of c`,
    [
      ctx.tenant.tenantId,
      input.organizationId,
      input.action,
      input.resource,
      input.claimId ?? null,
      input.providerReference,
      input.amountMinor ?? null,
      input.currency ?? null,
    ],
  );
  let c = claim.rows[0];
  // A claim authorizes one provider effect. A copied metadata hint cannot cover
  // another refund, including simultaneous webhook deliveries.
  if (c) {
    const used = await db.query(
      "select 1 from authority.provider_events where claim_id=$1",
      [c.id],
    );
    if (used.rowCount) c = undefined;
  }
  await db.query(
    `insert into authority.provider_events
     (tenant_id,provider_reference,organization_id,action,resource,claim_id,received_at)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      ctx.tenant.tenantId,
      input.providerReference,
      input.organizationId,
      input.action,
      input.resource,
      c?.id ?? null,
      iso(ctx.now),
    ],
  );
  if (!c)
    await audit(db, {
      type: "bypass.detected",
      tenantId: ctx.tenant.tenantId,
      organizationId: input.organizationId,
      correlationId: ctx.correlationId,
      actor: actorOf(ctx),
      decision: "deny",
      reasonCode: "unclaimed_provider_effect",
      evaluation: {
        providerReference: input.providerReference,
        action: input.action,
        resource: input.resource,
      },
      at: ctx.now,
    });
  return {
    providerReference: input.providerReference,
    matched: Boolean(c),
    claimId: c?.id ?? null,
    bypassDetected: !c,
  };
}
