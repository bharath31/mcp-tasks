import {
  CONTRACT_VERSION,
  cancelOperationSchema,
  claimRequestSchema,
  createDelegationSchema,
  decisionSchema,
  batchDecisionSchema,
  leaseApprovalSchema,
  escalationSchema,
  reconciliationSchema,
  outcomeSchema,
  registerOperationSchema,
  requestApprovalSchema,
  revokeDelegationSchema,
  type ApiError,
} from "@task-authority/contracts";
import { z } from "zod";
import {
  approvalView,
  listApprovals,
  leaseApproval,
  decideBatch,
  escalateApproval,
  challengeApproval,
  decide,
  getApproval,
  pollApproval,
  requestApproval,
  recordApprovalProof,
} from "./approvals.js";
import { authenticate } from "./authn.js";
import { authorizeAndClaim, reportOutcome } from "./claims.js";
import type { ServiceConfig } from "./config.js";
import type { Ctx } from "./context.js";
import {
  createDelegation,
  getDelegation,
  revokeDelegation,
} from "./delegations.js";
import { ServiceError } from "./errors.js";
import {
  cancelOperation,
  getOperation,
  listAudit,
  queryAudit,
  registerOperation,
  sha256,
} from "./operations.js";
import {
  activatePolicy,
  listPolicies,
  publishPolicy,
  simulatePolicy,
  validatePolicy,
} from "./policies.js";
import { requirePermission } from "./authn.js";
import { approvalDigest } from "./digest.js";
import { reconcileProviderEvent } from "./reconciliation.js";
import { getUsage } from "./usage.js";
import { iso, type Db, type Store } from "./store.js";

void approvalView;
const MAX_BODY = 64 * 1024;
const CORRELATION = /^[A-Za-z0-9_\-.:]{8,100}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_\-.:]{8,128}$/;

type Route = {
  method: "GET" | "POST" | "PUT";
  pattern: RegExp;
  template: string;
  body?: z.ZodType;
  /** Mutations that accept Idempotency-Key. */
  idempotent?: boolean;
  run: (
    db: Db,
    ctx: Ctx,
    params: string[],
    body: any,
    query: URLSearchParams,
  ) => Promise<{ status: number; body: unknown }>;
  /** Documented query parameters (GET). */
  query?: string[];
};

const ok = (body: unknown, status = 200) => ({ status, body });
const ID = "([A-Za-z0-9:_\\-.]{1,200})";
const re = (s: string) => new RegExp(`^${s}$`);

const routes: Route[] = [
  {
    method: "POST",
    pattern: re(`/v1/approval-requests/${ID}/challenge`),
    template: "/v1/approval-requests/:id/challenge",
    body: z.object({}).strict(),
    run: async (db, ctx, [id]) => ok(await challengeApproval(db, ctx, id!)),
  },
  {
    method: "POST",
    pattern: re("/v1/approval-requests/digest"),
    template: "/v1/approval-requests/digest",
    body: z.object({}).strict(),
    run: async (db, ctx) => ok(await approvalDigest(db, ctx)),
  },
  {
    method: "POST",
    pattern: re("/v1/policies/validate"),
    template: "/v1/policies/validate",
    body: z.unknown(),
    run: async (_db, ctx, _p, b) => {
      requirePermission(ctx.caller, "policies:write");
      return ok(validatePolicy(b));
    },
  },
  {
    method: "GET",
    pattern: re("/v1/policies/templates"),
    template: "/v1/policies/templates",
    run: async (_db, ctx) => {
      requirePermission(ctx.caller, "policies:read");
      const { policyTemplates } = await import("./policy-templates.js");
      return ok({ templates: policyTemplates });
    },
  },
  {
    method: "PUT",
    pattern: re("/v1/policies/([^/]{1,1500})"),
    template: "/v1/policies/:resourceServer",
    body: z
      .object({
        document: z.unknown(),
        activate: z.boolean().optional(),
        shadow: z.boolean().optional(),
      })
      .strict(),
    idempotent: true,
    run: async (db, ctx, [rs], b) => {
      const resourceServer = decodeURIComponent(rs!);
      if ((b.document as any)?.resource_server !== resourceServer)
        throw new ServiceError(
          "invalid_request",
          "Policy resource_server must match its URL.",
        );
      return ok(
        await publishPolicy(db, ctx, b.document, {
          activate: b.activate,
          shadow: b.shadow,
        }),
        201,
      );
    },
  },
  {
    method: "GET",
    pattern: re("/v1/policies/([^/]{1,1500})"),
    template: "/v1/policies/:resourceServer",
    run: async (db, ctx, [rs]) =>
      ok(await listPolicies(db, ctx, decodeURIComponent(rs!))),
  },
  {
    method: "POST",
    pattern: re("/v1/policies/([^/]{1,1500})/activate"),
    template: "/v1/policies/:resourceServer/activate",
    body: z
      .object({
        version: z.string().min(1).max(200),
        shadow: z.boolean().optional(),
      })
      .strict(),
    run: async (db, ctx, [rs], b) =>
      ok(
        await activatePolicy(db, ctx, decodeURIComponent(rs!), b.version, {
          shadow: b.shadow,
        }),
      ),
  },
  {
    method: "POST",
    pattern: re("/v1/policies/([^/]{1,1500})/simulate"),
    template: "/v1/policies/:resourceServer/simulate",
    body: z
      .object({
        version: z.string().min(1).max(200),
        since: z.string().min(1).max(100),
      })
      .strict(),
    run: async (db, ctx, [rs], b) =>
      ok(
        await simulatePolicy(
          db,
          ctx,
          decodeURIComponent(rs!),
          b.version,
          b.since,
        ),
      ),
  },
  {
    method: "GET",
    pattern: re("/v1/approval-requests"),
    template: "/v1/approval-requests",
    query: ["status"],
    run: async (db, ctx, _p, _b, q) =>
      ok(await listApprovals(db, ctx, q.get("status") ?? "pending")),
  },
  {
    method: "POST",
    pattern: re("/v1/approval-requests/decisions"),
    template: "/v1/approval-requests/decisions",
    body: batchDecisionSchema,
    run: async (db, ctx, _p, b) => ok(await decideBatch(db, ctx, b)),
  },
  {
    method: "POST",
    pattern: re(`/v1/approval-requests/${ID}/lease`),
    template: "/v1/approval-requests/:id/lease",
    body: leaseApprovalSchema,
    run: async (db, ctx, [id], b) => ok(await leaseApproval(db, ctx, id!, b)),
  },
  {
    method: "POST",
    pattern: re(`/v1/approval-requests/${ID}/escalate`),
    template: "/v1/approval-requests/:id/escalate",
    body: escalationSchema,
    run: async (db, ctx, [id], b) =>
      ok(await escalateApproval(db, ctx, id!, b)),
  },
  {
    method: "POST",
    pattern: re("/v1/provider-events"),
    template: "/v1/provider-events",
    body: reconciliationSchema,
    run: async (db, ctx, _p, b) => ok(await reconcileProviderEvent(db, ctx, b)),
  },

  {
    method: "POST",
    pattern: re("/v1/delegations"),
    template: "/v1/delegations",
    body: createDelegationSchema,
    idempotent: true,
    run: async (db, ctx, _p, b) => ok(await createDelegation(db, ctx, b), 201),
  },
  {
    method: "GET",
    pattern: re(`/v1/delegations/${ID}`),
    template: "/v1/delegations/:id",
    run: async (db, ctx, [id]) => ok(await getDelegation(db, ctx, id!)),
  },
  {
    method: "POST",
    pattern: re(`/v1/delegations/${ID}/revoke`),
    template: "/v1/delegations/:id/revoke",
    body: revokeDelegationSchema,
    idempotent: true,
    run: async (db, ctx, [id], b) =>
      ok(await revokeDelegation(db, ctx, id!, b.reason)),
  },
  {
    method: "POST",
    pattern: re("/v1/operations"),
    template: "/v1/operations",
    body: registerOperationSchema,
    idempotent: true,
    run: async (db, ctx, _p, b) => ok(await registerOperation(db, ctx, b), 200),
  },
  {
    method: "GET",
    pattern: re(`/v1/operations/${ID}`),
    template: "/v1/operations/:id",
    run: async (db, ctx, [id]) => {
      const operation = await getOperation(db, ctx, id!);
      return ok({
        ...operation,
        status: operation.outcomeStatus,
        lifecycleStatus: operation.status,
      });
    },
  },
  {
    method: "POST",
    pattern: re(`/v1/operations/${ID}/approval-requests`),
    template: "/v1/operations/:id/approval-requests",
    body: requestApprovalSchema,
    idempotent: true,
    run: async (db, ctx, [id], b) =>
      ok(await requestApproval(db, ctx, id!, b), 200),
  },
  {
    method: "GET",
    pattern: re(`/v1/approval-requests/${ID}`),
    template: "/v1/approval-requests/:id",
    run: async (db, ctx, [id]) => ok(await getApproval(db, ctx, id!)),
  },
  {
    method: "POST",
    pattern: re(`/v1/approval-requests/${ID}/decisions`),
    template: "/v1/approval-requests/:id/decisions",
    body: decisionSchema,
    idempotent: true,
    run: async (db, ctx, [id], b) => ok(await decide(db, ctx, id!, b)),
  },
  {
    method: "POST",
    pattern: re(`/v1/approvals/${ID}/proof`),
    template: "/v1/approvals/:id/proof",
    body: z.object({ proof: z.string().min(1).max(16_384) }).strict(),
    idempotent: true,
    run: async (db, ctx, [id], b) =>
      ok(await recordApprovalProof(db, ctx, id!, b)),
  },
  {
    method: "POST",
    pattern: re(`/v1/operations/${ID}/claims`),
    template: "/v1/operations/:id/claims",
    body: claimRequestSchema,
    idempotent: true,
    run: async (db, ctx, [id], b) =>
      ok(await authorizeAndClaim(db, ctx, id!, b)),
  },
  {
    method: "POST",
    pattern: re(`/v1/operations/${ID}/outcomes`),
    template: "/v1/operations/:id/outcomes",
    body: outcomeSchema,
    idempotent: true,
    run: async (db, ctx, [id], b) => ok(await reportOutcome(db, ctx, id!, b)),
  },
  {
    method: "POST",
    pattern: re(`/v1/operations/${ID}/cancel`),
    template: "/v1/operations/:id/cancel",
    body: cancelOperationSchema,
    idempotent: true,
    run: async (db, ctx, [id], b) =>
      ok(await cancelOperation(db, ctx, id!, b.reason)),
  },
  {
    method: "GET",
    pattern: re(`/v1/operations/${ID}/audit`),
    template: "/v1/operations/:id/audit",
    run: async (db, ctx, [id]) => ok({ events: await listAudit(db, ctx, id!) }),
  },
  {
    method: "POST",
    pattern: re(`/v1/approval-requests/${ID}/ciba/poll`),
    template: "/v1/approval-requests/:id/ciba/poll",
    body: z.object({}).strict(),
    run: async (db, ctx, [id]) => ok(await pollApproval(db, ctx, id!)),
  },
  {
    method: "GET",
    pattern: re("/v1/audit"),
    template: "/v1/audit",
    query: [
      "correlationId",
      "operationId",
      "delegationId",
      "type",
      "reason",
      "limit",
      "after",
    ],
    run: async (db, ctx, _p, _b, q) => {
      const limit = Number(q.get("limit") ?? 50);
      const after = q.get("after") ? Number(q.get("after")) : undefined;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200 ||
        (after !== undefined && !Number.isInteger(after))
      )
        throw new ServiceError(
          "invalid_request",
          "limit must be 1-200 and after an integer.",
        );
      const pick = (k: string) => {
        const v = q.get(k);
        if (v !== null && !/^[A-Za-z0-9:_\-.]{1,200}$/.test(v))
          throw new ServiceError("invalid_request", `Malformed ${k}.`);
        return v ?? undefined;
      };
      return ok(
        await queryAudit(db, ctx, {
          correlationId: pick("correlationId"),
          operationId: pick("operationId"),
          delegationId: pick("delegationId"),
          type: pick("type"),
          reason: pick("reason"),
          limit,
          after,
        }),
      );
    },
  },
  {
    method: "GET",
    pattern: re("/v1/usage"),
    template: "/v1/usage",
    query: ["day"],
    run: async (db, ctx, _p, _b, q) =>
      ok(await getUsage(db, ctx, q.get("day"))),
  },
];

export const routeTable = routes.map((r) => ({
  method: r.method,
  template: r.template,
  idempotent: Boolean(r.idempotent),
  hasBody: Boolean(r.body),
  query: r.query ?? [],
  body: r.body,
}));

export type HandlerOptions = {
  store: Store;
  config: ServiceConfig;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
  alertHook?: (event: Record<string, unknown>) => Promise<void>;
};

export function createHandler(opts: HandlerOptions) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
  const windows = new Map<string, { start: number; n: number }>();
  const newId = (p: string) =>
    `${p}_${crypto.randomUUID().replaceAll("-", "")}`;

  const cors = (req: Request) => {
    const origin = req.headers.get("origin");
    const h: Record<string, string> = { vary: "origin" };
    if (origin && opts.config.allowedOrigins.includes(origin)) {
      h["access-control-allow-origin"] = origin;
      h["access-control-expose-headers"] =
        "x-correlation-id,idempotent-replayed,retry-after";
    }
    return h;
  };
  const headers = (
    req: Request,
    correlationId: string,
    extra: Record<string, string> = {},
  ) => ({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-correlation-id": correlationId,
    "x-task-authority-contract": CONTRACT_VERSION,
    ...cors(req),
    ...extra,
  });
  const send = (
    req: Request,
    correlationId: string,
    status: number,
    body: unknown,
    extra?: Record<string, string>,
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: headers(req, correlationId, extra),
    });
  const fail = (
    req: Request,
    correlationId: string,
    e: ServiceError,
    extra?: Record<string, string>,
  ) => {
    const body: ApiError = {
      code: e.code,
      message: e.message,
      correlationId: (e.details?.correlationId as string) ?? correlationId,
      retryable: e.retryable,
      ...(e.details ? { details: e.details } : {}),
    };
    return send(req, correlationId, e.status, body, extra);
  };

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const supplied = req.headers.get("x-correlation-id");
    const correlationId =
      supplied && CORRELATION.test(supplied) ? supplied : newId("cor");
    const started = now();
    try {
      if (req.method === "OPTIONS") {
        const h = cors(req);
        if (!h["access-control-allow-origin"])
          return new Response(null, { status: 403 });
        return new Response(null, {
          status: 204,
          headers: {
            ...h,
            "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
            "access-control-allow-headers":
              "authorization,content-type,idempotency-key,x-correlation-id,x-task-authority-subject,dpop",
            "access-control-max-age": "600",
          },
        });
      }
      if (url.pathname === "/healthz" && req.method === "GET") {
        try {
          await opts.store.ping();
          return send(req, correlationId, 200, {
            status: "ok",
            contract: CONTRACT_VERSION,
          });
        } catch {
          return send(req, correlationId, 503, { status: "unavailable" });
        }
      }
      const route = routes.find(
        (r) => r.method === req.method && r.pattern.test(url.pathname),
      );
      if (!route) {
        if (routes.some((r) => r.pattern.test(url.pathname)))
          return fail(
            req,
            correlationId,
            new ServiceError("invalid_request", "Method not allowed."),
            { allow: "GET,POST,PUT" },
          );
        return fail(
          req,
          correlationId,
          new ServiceError("not_found", "Not found."),
        );
      }
      const params = (url.pathname.match(route.pattern) ?? []).slice(1);

      const caller = await authenticate(
        req,
        opts.config,
        now(),
        opts.store.pool,
      );
      const tenant = caller.tenant;
      // Per-tenant, per-caller rate limit (in-process; see README limits).
      const who = `${tenant.tenantId}:${caller.kind === "service" ? caller.clientId : caller.subject.sub}`;
      const minute = Math.floor(started / 60_000);
      if (windows.size > 5000)
        for (const [k, v] of windows) if (v.start !== minute) windows.delete(k);
      const w = windows.get(who);
      if (!w || w.start !== minute) windows.set(who, { start: minute, n: 1 });
      else if (++w.n > tenant.quotas.requestsPerMinute)
        return fail(
          req,
          correlationId,
          new ServiceError("rate_limited", "Too many requests."),
          { "retry-after": "30" },
        );

      let body: unknown = undefined;
      if (route.body) {
        const text = await req.text();
        if (text.length > MAX_BODY)
          throw new ServiceError("invalid_request", "Request body too large.");
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          throw new ServiceError("invalid_request", "Body must be JSON.");
        }
        const parsed = route.body.safeParse(json);
        if (!parsed.success)
          throw new ServiceError(
            "invalid_request",
            "Request failed schema validation.",
            {
              issues: parsed.error.issues
                .slice(0, 10)
                .map((i) => ({ path: i.path.join("."), code: i.code })),
            },
          );
        body = parsed.data;
      }
      const idemKey = req.headers.get("idempotency-key");
      if (idemKey && !IDEMPOTENCY.test(idemKey))
        throw new ServiceError("invalid_request", "Malformed Idempotency-Key.");

      const ctx: Ctx = {
        caller,
        tenant,
        config: opts.config,
        now: now(),
        correlationId,
        correlationSupplied: Boolean(supplied && CORRELATION.test(supplied)),
        newId,
      };
      const scope = `${caller.kind === "service" ? caller.clientId : caller.subject.sub}|${route.method} ${route.template}|${params.join("/")}`;
      let replayed = false;
      const result = await opts.store.tx(async (db) => {
        if (route.idempotent && idemKey) {
          const hash = await sha256(JSON.stringify(body ?? null));
          await db.query(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            [`${tenant.tenantId}|${scope}|${idemKey}`],
          );
          const prior = await db.query(
            "select request_hash, status, response from authority.idempotency_keys where tenant_id=$1 and scope=$2 and key=$3",
            [tenant.tenantId, scope, idemKey],
          );
          if (prior.rows[0]) {
            if (prior.rows[0].request_hash !== hash)
              throw new ServiceError(
                "operation_conflict",
                "Idempotency-Key was reused with different parameters.",
              );
            replayed = true;
            return {
              status: prior.rows[0].status as number,
              body: prior.rows[0].response,
            };
          }
          const out = await route.run(db, ctx, params, body, url.searchParams);
          await db.query(
            "insert into authority.idempotency_keys (tenant_id, scope, key, request_hash, status, response, created_at) values ($1,$2,$3,$4,$5,$6,$7)",
            [
              tenant.tenantId,
              scope,
              idemKey,
              hash,
              out.status,
              JSON.stringify(out.body),
              iso(ctx.now),
            ],
          );
          return out;
        }
        return route.run(db, ctx, params, body, url.searchParams);
      });
      if (
        route.template === "/v1/provider-events" &&
        (result.body as any)?.bypassDetected &&
        opts.alertHook
      ) {
        try {
          await opts.alertHook({
            type: "bypass.detected",
            tenantId: tenant.tenantId,
            ...(result.body as Record<string, unknown>),
          });
        } catch {
          log({ event: "alert.delivery_failed", correlationId });
        }
      }
      log({
        event: "request",
        route: route.template,
        status: result.status,
        correlationId,
        ms: now() - started,
      });
      return send(
        req,
        correlationId,
        result.status,
        result.body,
        replayed ? { "idempotent-replayed": "true" } : undefined,
      );
    } catch (e) {
      if (e instanceof ServiceError) {
        log({
          event: "request_denied",
          path: url.pathname,
          code: e.code,
          correlationId,
        });
        return fail(req, correlationId, e);
      }
      const pgCode = (e as { code?: string }).code;
      // 55P03 lock_not_available, 57014 statement timeout, 40001/40P01 serialization.
      const transient = [
        "55P03",
        "57014",
        "40001",
        "40P01",
        "ECONNREFUSED",
      ].includes(String(pgCode));
      log({
        event: "request_failed",
        path: url.pathname,
        type: e instanceof Error ? e.name : "unknown",
        pgCode,
        correlationId,
      });
      return fail(
        req,
        correlationId,
        transient
          ? new ServiceError(
              "authorization_unavailable",
              "Datastore temporarily unavailable. Nothing was authorized.",
              { dependency: "datastore" },
            )
          : new ServiceError("internal_error", "Unexpected error."),
      );
    }
  };
}
