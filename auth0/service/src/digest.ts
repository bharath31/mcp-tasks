import { listApprovals } from "./approvals.js";
import type { Ctx } from "./context.js";
import { ServiceError } from "./errors.js";
import { iso, type Db } from "./store.js";

/** A reference digest payload, containing no decision authority or item secrets. */
export async function approvalDigest(db: Db, ctx: Ctx) {
  if (ctx.caller.kind !== "user")
    throw new ServiceError("not_authorized", "Reviewer identity required.");
  const subject = ctx.caller.subject.sub;
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${ctx.tenant.tenantId}|digest|${subject}`,
  ]);
  const { approvals } = await listApprovals(db, ctx, "pending");
  const previous = await db.query(
    "select sent_at from authority.reviewer_digests where tenant_id=$1 and reviewer_id=$2",
    [ctx.tenant.tenantId, subject],
  );
  const last = previous.rows[0]?.sent_at?.getTime() ?? 0;
  const queueUrl = "/review";
  if (!approvals.length || last > ctx.now - 15 * 60_000)
    return { ready: false, count: approvals.length, queueUrl };
  const oldest = Math.max(
    0,
    Math.floor(
      (ctx.now - Math.min(...approvals.map((a) => Date.parse(a.requestedAt)))) /
        60_000,
    ),
  );
  await db.query(
    `insert into authority.reviewer_digests(tenant_id,reviewer_id,sent_at) values($1,$2,$3)
    on conflict(tenant_id,reviewer_id) do update set sent_at=excluded.sent_at`,
    [ctx.tenant.tenantId, subject, iso(ctx.now)],
  );
  return {
    ready: true,
    count: approvals.length,
    oldestMinutes: oldest,
    message: `${approvals.length} awaiting, oldest ${oldest} min`,
    queueUrl,
  };
}
