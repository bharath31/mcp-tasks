import type { DelegationView } from "@task-authority/contracts";
import type { Caller } from "./authn.js";
import type { ServiceConfig, TenantConfig } from "./config.js";
import { ServiceError } from "./errors.js";
import { fgaCheck } from "./fga.js";
import { iso, type DelegationRow, type Db } from "./store.js";

export type Ctx = {
  caller: Caller;
  tenant: TenantConfig;
  config: ServiceConfig;
  now: number;
  /** Request-scoped correlation id, used when no persistent chain id applies yet. */
  correlationId: string;
  /** True when the caller sent X-Correlation-Id (it then names the chain explicitly). */
  correlationSupplied: boolean;
  newId: (prefix: string) => string;
};

export const actorOf = (ctx: Ctx) =>
  ctx.caller.kind === "service"
    ? ({ kind: "service", id: ctx.caller.clientId } as const)
    : ({ kind: "user", id: ctx.caller.subject.sub } as const);

export function delegationStatus(d: DelegationRow, now: number) {
  if (d.revoked_at) return "revoked" as const;
  if (d.expires_at.getTime() <= now) return "expired" as const;
  return "active" as const;
}

export function delegationView(d: DelegationRow, now: number): DelegationView {
  return {
    id: d.id,
    tenantId: d.tenant_id,
    organizationId: d.organization_id,
    ownerType: d.owner_type,
    actorId: d.actor_id,
    agentId: d.agent_id,
    resource: d.resource,
    actions: d.actions,
    ceilings: d.ceilings,
    status: delegationStatus(d, now),
    createdAt: iso(d.created_at),
    expiresAt: iso(d.expires_at),
    revokedAt: d.revoked_at ? iso(d.revoked_at) : null,
    correlationId: d.correlation_id,
  };
}

export const org = (id: string) => `organization:${id}`;

/** Trusted-backend registration of the calling client for an organization. */
export async function requireTrustedBackend(
  ctx: Ctx,
  organizationId: string,
): Promise<string> {
  if (ctx.caller.kind !== "service")
    throw new ServiceError("not_authorized", "Trusted backend required.");
  const ok = await fgaCheck(
    ctx.tenant.fga,
    `client:${ctx.caller.clientId}`,
    "trusted_backend",
    org(organizationId),
  );
  if (!ok)
    throw new ServiceError(
      "not_authorized",
      "Caller is not a trusted backend for this organization.",
    );
  return ctx.caller.clientId;
}

/**
 * Read access to a stored record. Service callers need the explicit read
 * permission; human callers must still be members of the organization (so a
 * former employee loses access) and be the owner/initiator or an investigator.
 * Anything else is reported as plain "not found".
 */
export async function canRead(
  ctx: Ctx,
  db: Db,
  row: { tenant_id: string; organization_id: string },
  involved: Array<string | null>,
  servicePermission: string,
  extraRelation?: string,
): Promise<boolean> {
  void db;
  if (row.tenant_id !== ctx.tenant.tenantId) return false;
  if (ctx.caller.kind === "service")
    return ctx.caller.permissions.has(servicePermission);
  const { subject } = ctx.caller;
  if (subject.orgId && subject.orgId !== row.organization_id) return false;
  const object = org(row.organization_id);
  const user = `user:${subject.sub}`;
  if (await fgaCheck(ctx.tenant.fga, user, "investigator", object)) return true;
  if (
    extraRelation &&
    (await fgaCheck(ctx.tenant.fga, user, extraRelation, object))
  )
    return true;
  if (!involved.includes(subject.sub)) return false;
  return fgaCheck(ctx.tenant.fga, user, "member", object);
}

export const notFound = () => new ServiceError("not_found", "Not found.");
