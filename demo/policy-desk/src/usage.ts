// Who uses the demo and what it costs, for the operator's /admin page. Everything
// here lives outside the per-sandbox tenants, so it outlasts TTL cleanup:
// visitors (one row per Auth0 user), usage_events (an append-only activity log)
// and tenant_usage (Task Authority totals archived just before a tenant is wiped).
import { jwtVerify } from "jose";
import { issuerOf, jwks, type Verified } from "./auth0.js";
import { sandboxIdFor, type Host } from "./host.js";
import type { Db } from "../../../auth0/service/src/store.js";

export type UsageKind =
  | "sandbox_created"
  | "sandbox_reset"
  | "scenario_run"
  | "policy_published"
  | "simulation"
  | "agent_key_issued"
  | "model_call";

/** The visitor's ID token, sent by the SPA as X-Id-Token. Used only for the email. */
async function idClaims(host: Host, req: Request, sub: string) {
  const raw = req.headers.get("x-id-token");
  const clientId = host.env.SPA_CLIENT_ID;
  if (!raw || !clientId) return null;
  try {
    const { payload } = await jwtVerify(raw, jwks(host.env), {
      issuer: issuerOf(host.env),
      audience: clientId,
      algorithms: ["RS256", "ES256", "PS256"],
    });
    if (payload.sub !== sub) return null;
    return {
      email: typeof payload.email === "string" ? payload.email : null,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === "string" ? payload.name : null,
    };
  } catch {
    return null;
  }
}

/**
 * Upserts the visitor and bumps last_seen_at. Writes at most once a minute per visitor
 * unless the ID token brings a new email or name. Never fails the request.
 */
export async function touchVisitor(host: Host, req: Request, v: Verified) {
  try {
    const claims = await idClaims(host, req, v.sub);
    const now = new Date(host.now()).toISOString();
    await host.conn.db.query(
      `insert into policy_desk.visitors (sub, sandbox_id, email, email_verified, name, first_seen_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $6)
       on conflict (sub) do update set
         last_seen_at = greatest(visitors.last_seen_at, excluded.last_seen_at),
         email = coalesce(excluded.email, visitors.email),
         email_verified = case when excluded.email is not null then excluded.email_verified else visitors.email_verified end,
         name = coalesce(excluded.name, visitors.name)
       where visitors.last_seen_at < excluded.last_seen_at - interval '1 minute'
          or (excluded.email is not null and excluded.email is distinct from visitors.email)
          or (excluded.email is not null and excluded.email_verified <> visitors.email_verified)
          or (excluded.name is not null and excluded.name is distinct from visitors.name)`,
      [
        v.sub,
        await sandboxIdFor(v.sub),
        claims?.email ?? null,
        claims?.emailVerified ?? false,
        claims?.name ?? null,
        now,
      ],
    );
    return claims;
  } catch (e) {
    console.error(
      JSON.stringify({ event: "usage_visitor_failed", message: String(e) }),
    );
    return null;
  }
}

/** Appends one activity row. Never fails the request it describes. */
export async function recordEvent(
  host: Host,
  sandboxId: string,
  kind: UsageKind,
  detail?: Record<string, unknown>,
  model?: { model: string; inputTokens?: number; outputTokens?: number },
) {
  try {
    await host.conn.db.query(
      `insert into policy_desk.usage_events (at, sandbox_id, kind, detail, model, input_tokens, output_tokens)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        new Date(host.now()).toISOString(),
        sandboxId,
        kind,
        detail ? JSON.stringify(detail) : null,
        model?.model ?? null,
        model?.inputTokens ?? null,
        model?.outputTokens ?? null,
      ],
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "usage_record_failed",
        kind,
        message: String(e),
      }),
    );
  }
}

/**
 * Hook for the AI refund agent: call once per model invocation. Workers AI returns
 * `usage: { prompt_tokens, completion_tokens }`; pass those as input/output tokens.
 */
export const recordModelCall = (
  host: Host,
  sandboxId: string,
  call: {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
    ok?: boolean;
    scenario?: string;
  },
) =>
  recordEvent(
    host,
    sandboxId,
    "model_call",
    {
      ok: call.ok ?? true,
      ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
      ...(call.scenario ? { scenario: call.scenario } : {}),
    },
    call,
  );

// Per-tenant Task Authority totals. $1 null selects every live sandbox tenant.
const TENANT_STATS = `
  with t as (
    select tenant_id from authority.operations where ($1::text[] is null and tenant_id like 'pd\\_%') or tenant_id = any($1)
    union
    select tenant_id from authority.approvals where ($1::text[] is null and tenant_id like 'pd\\_%') or tenant_id = any($1)
    union
    select tenant_id from authority.policy_versions where ($1::text[] is null and tenant_id like 'pd\\_%') or tenant_id = any($1)
  )
  select t.tenant_id,
    'sbx_' || substr(t.tenant_id, 4, 24) sandbox_id,
    (select count(*) from authority.operations o where o.tenant_id = t.tenant_id)::int operations,
    (select count(*) from authority.operations o where o.tenant_id = t.tenant_id and o.decision = 'allow' and o.approval_requirement = 'none')::int auto_allowed,
    (select count(*) from authority.operations o where o.tenant_id = t.tenant_id and o.decision = 'deny')::int denied,
    (select count(*) from authority.approvals a where a.tenant_id = t.tenant_id)::int approvals_requested,
    (select count(*) from authority.approvals a where a.tenant_id = t.tenant_id and a.status = 'approved')::int approvals_approved,
    (select count(*) from authority.approvals a where a.tenant_id = t.tenant_id and a.status = 'rejected')::int approvals_rejected,
    (select count(*) from authority.claims c where c.tenant_id = t.tenant_id and c.status = 'succeeded')::int refunds_executed,
    (select count(*) from authority.policy_versions p where p.tenant_id = t.tenant_id)::int policy_versions
  from t where t.tenant_id ~ '^pd_[a-f0-9]{24}_g[0-9]+$'`;

const STAT_COLS = [
  "operations",
  "auto_allowed",
  "denied",
  "approvals_requested",
  "approvals_approved",
  "approvals_rejected",
  "refunds_executed",
  "policy_versions",
] as const;

/** Snapshots the totals of tenants about to be wiped. Call in the wipe's transaction. */
export async function archiveTenants(db: Db, tenantIds: string[], now: number) {
  if (!tenantIds.length) return;
  await db.query(
    `insert into policy_desk.tenant_usage (tenant_id, sandbox_id, ${STAT_COLS.join(", ")}, archived_at)
     select tenant_id, sandbox_id, ${STAT_COLS.join(", ")}, $2 from (${TENANT_STATS}) s
      where ${STAT_COLS.map((c) => `${c} > 0`).join(" or ")}`,
    [tenantIds, new Date(now).toISOString()],
  );
}

// ---------- admin ----------

const list = (s: string | undefined) =>
  (s ?? "")
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Operator check, server-side: the Auth0 subject is in ADMIN_SUBS, or the visitor's
 * verified email (from an ID token signed by the tenant for this SPA, same subject)
 * is in ADMIN_EMAILS. With neither configured nobody is an admin.
 */
export function isAdmin(
  host: Host,
  v: Verified,
  claims: { email: string | null; emailVerified: boolean } | null,
) {
  if (list(host.env.ADMIN_SUBS).includes(v.sub)) return true;
  const email = claims?.emailVerified ? claims.email?.toLowerCase() : null;
  return (
    !!email &&
    list(host.env.ADMIN_EMAILS).some((x) => x.toLowerCase() === email)
  );
}

type Stats = Record<(typeof STAT_COLS)[number], number>;
const zeroStats = (): Stats =>
  Object.fromEntries(STAT_COLS.map((c) => [c, 0])) as Stats;
const camel = (s: string) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
const toView = (s: Stats) =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [camel(k), v]));

export async function adminUsage(host: Host, days = 14) {
  const { db } = host.conn;
  const now = host.now();
  const nowIso = new Date(now).toISOString();
  const [visitors, sandboxes, events, live, archived, daily, recent] =
    await Promise.all([
      db.query(
        "select sandbox_id, email, email_verified, name, first_seen_at, last_seen_at from policy_desk.visitors",
      ),
      db.query(
        "select id, generation, created_at, expires_at, last_reset_at from policy_desk.sandboxes",
      ),
      db.query(
        `select sandbox_id, kind, count(*)::int n, min(at) first_at, max(at) last_at,
                coalesce(sum(input_tokens), 0)::bigint input_tokens, coalesce(sum(output_tokens), 0)::bigint output_tokens
           from policy_desk.usage_events group by sandbox_id, kind`,
      ),
      db.query(TENANT_STATS, [null]),
      db.query(
        `select sandbox_id, ${STAT_COLS.map((c) => `sum(${c})::int ${c}`).join(", ")}
           from policy_desk.tenant_usage group by sandbox_id`,
      ),
      db.query(
        `with d as (select generate_series(date_trunc('day', $1::timestamptz) - ($2::int - 1) * interval '1 day',
                                          date_trunc('day', $1::timestamptz), interval '1 day') bucket)
         select to_char(d.bucket, 'YYYY-MM-DD') as day,
           (select count(*) from policy_desk.visitors v where date_trunc('day', v.first_seen_at) = d.bucket)::int new_visitors,
           (select count(distinct e.sandbox_id) from policy_desk.usage_events e where date_trunc('day', e.at) = d.bucket)::int active_sandboxes,
           (select count(*) from policy_desk.usage_events e where date_trunc('day', e.at) = d.bucket and e.kind = 'sandbox_created')::int sandboxes_created,
           (select count(*) from policy_desk.usage_events e where date_trunc('day', e.at) = d.bucket and e.kind = 'scenario_run')::int scenario_runs,
           (select count(*) from policy_desk.usage_events e where date_trunc('day', e.at) = d.bucket and e.kind = 'model_call')::int model_calls,
           (select coalesce(sum(coalesce(e.input_tokens, 0) + coalesce(e.output_tokens, 0)), 0) from policy_desk.usage_events e
             where date_trunc('day', e.at) = d.bucket and e.kind = 'model_call')::bigint tokens
         from d order by d.bucket`,
        [nowIso, days],
      ),
      db.query(
        "select at, sandbox_id, kind, detail, model, input_tokens, output_tokens from policy_desk.usage_events order by at desc, id desc limit 60",
      ),
    ]);

  type Row = {
    sandboxId: string;
    email: string | null;
    emailVerified: boolean;
    name: string | null;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    sandbox: {
      active: boolean;
      generation: number;
      createdAt: string;
      expiresAt: string;
      lastResetAt: string;
    } | null;
    events: Record<string, number>;
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    stats: Stats;
  };
  const rows = new Map<string, Row>();
  const row = (sandboxId: string): Row => {
    let r = rows.get(sandboxId);
    if (!r) {
      r = {
        sandboxId,
        email: null,
        emailVerified: false,
        name: null,
        firstSeenAt: null,
        lastSeenAt: null,
        sandbox: null,
        events: {},
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        stats: zeroStats(),
      };
      rows.set(sandboxId, r);
    }
    return r;
  };
  const iso = (d: Date | string | null) =>
    d ? new Date(d).toISOString() : null;
  const later = (a: string | null, b: string | null) =>
    !a ? b : !b ? a : a > b ? a : b;

  for (const v of visitors.rows) {
    const r = row(v.sandbox_id);
    r.email = v.email;
    r.emailVerified = v.email_verified;
    r.name = v.name;
    r.firstSeenAt = iso(v.first_seen_at);
    r.lastSeenAt = iso(v.last_seen_at);
  }
  for (const s of sandboxes.rows) {
    const r = row(s.id);
    r.sandbox = {
      active: new Date(s.expires_at).getTime() > now,
      generation: s.generation,
      createdAt: iso(s.created_at)!,
      expiresAt: iso(s.expires_at)!,
      lastResetAt: iso(s.last_reset_at)!,
    };
  }
  for (const e of events.rows) {
    const r = row(e.sandbox_id);
    r.events[e.kind] = e.n;
    r.lastSeenAt = later(r.lastSeenAt, iso(e.last_at));
    r.firstSeenAt ??= iso(e.first_at);
    if (e.kind === "model_call") {
      r.modelCalls = e.n;
      r.inputTokens = Number(e.input_tokens);
      r.outputTokens = Number(e.output_tokens);
    }
  }
  for (const s of [...live.rows, ...archived.rows]) {
    const r = row(s.sandbox_id);
    for (const c of STAT_COLS) r.stats[c] += Number(s[c] ?? 0);
  }

  const all = [...rows.values()];
  const sum = (f: (r: Row) => number) => all.reduce((a, r) => a + f(r), 0);
  const ev = (k: UsageKind) => (r: Row) => r.events[k] ?? 0;
  const stat = (k: (typeof STAT_COLS)[number]) => (r: Row) => r.stats[k];
  const dayAgo = new Date(now - 86400_000).toISOString();

  return {
    generatedAt: nowIso,
    modelTracking: sum((r) => r.modelCalls) > 0,
    totals: {
      visitors: visitors.rows.length,
      activeLast24h: all.filter((r) => (r.lastSeenAt ?? "") >= dayAgo).length,
      activeSandboxes: all.filter((r) => r.sandbox?.active).length,
      sandboxesCreated: sum(ev("sandbox_created")),
      resets: sum(ev("sandbox_reset")),
      scenarioRuns: sum(ev("scenario_run")),
      policyPublishes: sum(ev("policy_published")),
      simulations: sum(ev("simulation")),
      operations: sum(stat("operations")),
      autoAllowed: sum(stat("auto_allowed")),
      denied: sum(stat("denied")),
      approvalsRequested: sum(stat("approvals_requested")),
      approvalsApproved: sum(stat("approvals_approved")),
      approvalsRejected: sum(stat("approvals_rejected")),
      refundsExecuted: sum(stat("refunds_executed")),
      modelCalls: sum((r) => r.modelCalls),
      inputTokens: sum((r) => r.inputTokens),
      outputTokens: sum((r) => r.outputTokens),
    },
    daily: daily.rows.map((d) => ({
      day: d.day,
      newVisitors: d.new_visitors,
      activeSandboxes: d.active_sandboxes,
      sandboxesCreated: d.sandboxes_created,
      scenarioRuns: d.scenario_runs,
      modelCalls: d.model_calls,
      tokens: Number(d.tokens),
    })),
    users: all
      .sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))
      .map((r) => ({
        sandboxId: r.sandboxId,
        email: r.email,
        emailVerified: r.emailVerified,
        name: r.name,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        sandbox: r.sandbox,
        sandboxesCreated: r.events.sandbox_created ?? 0,
        resets: r.events.sandbox_reset ?? 0,
        scenarioRuns: r.events.scenario_run ?? 0,
        policyPublishes: r.events.policy_published ?? 0,
        simulations: r.events.simulation ?? 0,
        modelCalls: r.modelCalls,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        ...toView(r.stats),
      })),
    recent: recent.rows.map((e) => ({
      at: iso(e.at),
      sandboxId: e.sandbox_id,
      email: rows.get(e.sandbox_id)?.email ?? null,
      kind: e.kind,
      detail: e.detail,
      model: e.model,
      inputTokens: e.input_tokens,
      outputTokens: e.output_tokens,
    })),
  };
}
