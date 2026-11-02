import type { Ctx } from "./context.js";
import { ServiceError } from "./errors.js";
import { requirePermission } from "./authn.js";
import type { Db } from "./store.js";

const day = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Usage counter (not billing): tenant, UTC day, metric. */
export async function bump(
  db: Db,
  ctx: Ctx,
  metric: string,
  tenantId = ctx.tenant.tenantId,
) {
  await db.query(
    `insert into authority.usage_counters (tenant_id, day, metric, count) values ($1,$2,$3,1)
     on conflict (tenant_id, day, metric) do update set count = authority.usage_counters.count + 1`,
    [tenantId, day(ctx.now), metric],
  );
}

export async function getUsage(db: Db, ctx: Ctx, dayParam?: string | null) {
  requirePermission(ctx.caller, "usage:read");
  const d = dayParam ?? day(ctx.now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d))
    throw new ServiceError("invalid_request", "day must be YYYY-MM-DD.");
  const r = await db.query<{ metric: string; count: string }>(
    "select metric, count from authority.usage_counters where tenant_id=$1 and day=$2 order by metric",
    [ctx.tenant.tenantId, d],
  );
  return {
    tenantId: ctx.tenant.tenantId,
    day: d,
    counters: Object.fromEntries(
      r.rows.map((x) => [x.metric, Number(x.count)]),
    ),
    quotas: ctx.tenant.quotas,
    note: "Counters are operational usage, not billing.",
  };
}
