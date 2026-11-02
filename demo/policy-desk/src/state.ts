import { clientToken } from "./auth0.js";
import {
  sdk,
  serviceHandler,
  tenantIdOf,
  type Host,
  type Sandbox,
} from "./host.js";
import { RESOURCE_SERVER } from "./env.js";
import { listOrders } from "./orders.js";
import { DEFAULT_SETTINGS, sandboxPolicy } from "./policy.js";

function outcomeStatus(r: any) {
  if (r.decision === "deny") return "denied";
  if (r.status === "rejected") return "rejected";
  if (r.status === "cancelled") return "cancelled";
  if (r.claim_status === "succeeded") return "completed";
  if (r.claim_status === "failed") return "failed";
  // Dispatched, outcome not yet known: never shown as failed or as still to run.
  if (r.claim_status === "unknown" || r.claim_status === "pending")
    return "reconciling";
  if (r.approval_status === "approved") return "approved";
  return r.approval_requirement === "human" ? "pending_approval" : "approved";
}

export async function sandboxState(host: Host, s: Sandbox) {
  const tenantId = tenantIdOf(s);
  const { db } = host.conn;
  const ops = await db.query(
    `select o.id, o.action, o.arguments, o.facts, o.actor, o.decision, o.reason_code, o.rule_ids,
            o.policy_version, o.policy_details, o.status, o.digest, o.created_at, o.initiator_id,
            o.approval_requirement,
            a.id approval_id, a.status approval_status,
            (select count(*)::int from authority.approval_decisions d where d.approval_id=a.id and d.decision='approve') approvals,
            (select c.status from authority.claims c where c.operation_id=o.id order by seq desc limit 1) claim_status
       from authority.operations o
       left join lateral (select * from authority.approvals x where x.operation_id=o.id
            order by (x.status in ('pending','approved')) desc, x.requested_at desc limit 1) a on true
      where o.tenant_id=$1 order by o.created_at desc, o.id limit 50`,
    [tenantId],
  );
  const used = await db.query(
    `select coalesce(sum(amount_minor),0)::bigint amt, count(*)::int n from authority.policy_budget_consumption
      where tenant_id=$1 and rule_id='small' and status in ('held','captured') and consumed_at > now() - interval '24 hours'`,
    [tenantId],
  );
  return {
    sandboxId: s.id,
    generation: s.generation,
    orders: await listOrders(db, tenantId),
    operations: ops.rows.map((r: any) => ({
      id: r.id,
      action: r.action,
      amountMinor: r.arguments?.amountMinor ?? null,
      orderId: r.arguments?.orderId ?? null,
      customer: r.facts?.customer ?? null,
      reason: r.facts?.reason ?? "",
      actor: r.actor,
      initiator: r.initiator_id,
      decision: r.decision,
      reasonCode: r.reason_code,
      ruleIds: r.rule_ids,
      policyVersion: r.policy_version,
      tier: r.policy_details?.tier ?? null,
      assurance: r.policy_details?.assurance?.assurance ?? null,
      factors: r.policy_details?.assurance?.factors ?? null,
      outcomeStatus: outcomeStatus(r),
      approval: r.approval_id
        ? {
            id: r.approval_id,
            status: r.approval_status,
            quorum: r.policy_details?.quorum ?? 1,
            approvals: r.approvals,
          }
        : null,
      digest: r.digest,
      createdAt: r.created_at,
    })),
    budget: {
      usedMinor: Number(used.rows[0].amt),
      maxMinor: (s.policySettings ?? DEFAULT_SETTINGS).budgetMaxMinor,
      usedCount: used.rows[0].n,
      maxCount: (s.policySettings ?? DEFAULT_SETTINGS).budgetMaxCount,
    },
  };
}

export async function sandboxAudit(
  host: Host,
  s: Sandbox,
  operationId: string,
) {
  const events = await sdk(host, s, "auditor").audit.list(operationId);
  return {
    events: events.map((e) => {
      const ev = e.evaluation as any;
      return {
        id: e.id,
        type: e.type,
        decision: e.decision,
        reasonCode: e.reasonCode,
        actor: e.actor,
        createdAt: e.at,
        ruleIds: ev?.ruleIds ?? null,
        policyVersion: ev?.policyVersion ?? null,
        act: ev?.actor?.act ?? ev?.policyActor?.act ?? null,
        policyActor: ev?.actor ?? ev?.policyActor ?? null,
        evaluation: e.evaluation,
      };
    }),
  };
}

/** What-if: re-run recent operations against a candidate agent auto-approve limit. */
export async function simulate(host: Host, s: Sandbox, thresholdMinor: number) {
  const handler = serviceHandler(host, s);
  const admin = await clientToken(host.env, host.deps, "admin");
  const version = `whatif-${thresholdMinor}`;
  const doc = sandboxPolicy(
    {
      ...(s.policySettings ?? DEFAULT_SETTINGS),
      agentAutoLimitMinor: thresholdMinor,
    },
    version,
    host.env,
  );
  const call = (method: string, path: string, body?: unknown) =>
    handler(
      new Request(`${host.origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${admin}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const base = `/v1/policies/${encodeURIComponent(RESOURCE_SERVER)}`;
  const pub = await call("PUT", base, { document: doc });
  if (pub.status !== 201 && pub.status !== 409)
    throw new Error(`simulate_publish_${pub.status}`);
  const sim = await call("POST", `${base}/simulate`, { version, since: "24h" });
  const out = (await sim.json()) as any;
  if (sim.status !== 200) throw new Error(`simulate_${sim.status}`);
  const state = await sandboxState(host, s);
  const byId = new Map(state.operations.map((o) => [o.id, o]));
  const rows = (out.changed as any[]).map((c) => {
    const o = byId.get(c.operationId);
    const dollars =
      o?.amountMinor != null
        ? `$${(o.amountMinor / 100).toFixed(2)}`
        : "refund";
    return {
      operationId: c.operationId,
      summary: `${dollars} ${o?.customer ? `for ${o.customer} ` : ""}by ${o?.actor?.type ?? "caller"}`,
      before: c.previous,
      after: c.decision?.decision ?? c.decision,
    };
  });
  return {
    considered: Object.values(
      out.counts.outcomes as Record<string, number>,
    ).reduce((a, b) => a + b, 0),
    changed: rows.length,
    rows,
    candidate: { version, agentAutoApproveLimitMinor: thresholdMinor },
    counts: out.counts,
  };
}

/** Guided-tour booleans derived from real service state, never from client clicks. */
export async function progress(host: Host, s: Sandbox) {
  const t = tenantIdOf(s);
  const q = async (sql: string) =>
    (await host.conn.db.query(sql, [t])).rows[0]?.n > 0;
  return {
    signedIn: true,
    policyPublished: await q(
      "select count(*)::int n from authority.policy_state where tenant_id=$1 and active_version is not null",
    ),
    autoAllowedRefund: await q(
      `select count(*)::int n from authority.operations o join authority.claims c on c.operation_id=o.id
        where o.tenant_id=$1 and o.decision='allow' and o.approval_requirement='none' and c.status='succeeded'`,
    ),
    approvalRequestedRefund: await q(
      "select count(*)::int n from authority.approvals where tenant_id=$1",
    ),
    approvedWithStepUp: await q(
      `select count(*)::int n from authority.approval_decisions d join authority.approvals a on a.id=d.approval_id
        where a.tenant_id=$1 and d.decision='approve' and d.assurance->'amr' ? 'mfa'`,
    ),
    eventsPresent: await q(
      "select count(*)::int n from authority.audit_events where tenant_id=$1",
    ),
    policyEdited: await q(
      "select count(*)::int n from authority.policy_versions where tenant_id=$1 and version like 'refunds.edit-%'",
    ),
  };
}
