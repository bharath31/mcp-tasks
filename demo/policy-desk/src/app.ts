// Runtime-agnostic Worker app: routing, schema bootstrap and scheduled cleanup.
// worker.ts supplies the bundled migrations; tests supply them from disk.
import type { Deps } from "./auth0.js";
import { ConfigError, type Env, type Fetcher } from "./env.js";
import { cleanupExpired } from "./cleanup.js";
import {
  openHost,
  sandboxFromBearer,
  serviceHandler,
  type Host,
} from "./host.js";
import { sandboxApi } from "./api.js";
import { handleMcp } from "./mcp.js";
import { PRM_PATHS, protectedResourceMetadata } from "./oauth-metadata.js";
import { json, problem } from "./problem.js";
import { createRefund, getRefund, resolve, runRefund } from "./refunds.js";
import {
  approvalConfig,
  handleApprovalRoute,
} from "@task-authority/sdk/approve";
import { createPostgresApprovalLedger } from "@task-authority/sdk/approve/ledger";
import { ensureSchema, type Migration } from "./schema.js";
import { LimitExceeded } from "./ratelimit.js";
import type { Timings } from "./db.js";

/** Where the time went, for the browser's network panel and the console's "under the hood" view. */
function withServerTiming(
  res: Response,
  t: Timings | undefined,
  totalMs: number,
): Response {
  if (!t || res.headers.get("content-type")?.includes("ndjson")) return res;
  const parts = [
    `total;dur=${totalMs}`,
    `connect;desc="Postgres connect";dur=${t.connectMs}`,
    `db;desc="${t.queries} Postgres round trips";dur=${t.queryMs}`,
  ];
  if (t.fgaCalls)
    parts.push(`fga;desc="${t.fgaCalls} FGA calls";dur=${t.fgaMs}`);
  if (t.modelCalls)
    parts.push(`model;desc="${t.modelCalls} model calls";dur=${t.modelMs}`);
  const out = new Response(res.body, res);
  out.headers.set("server-timing", parts.join(", "));
  return out;
}

export type AppOptions = { migrations: Migration[]; deps?: Deps };

export function createApp(opts: AppOptions) {
  const deps = opts.deps ?? {};

  async function route(host: Host, req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/approve" || p.startsWith("/approve/")) {
      if (host.env.APPROVAL_MODE !== "approve")
        return problem(404, "not_found", "Not found.");
      const cfg = approvalConfig(host.env, {
        appUrl: host.env.APP_URL ?? host.origin,
        clientId: host.env.APPROVAL_CLIENT_ID ?? host.env.AUTH0_CLIENT_ID,
        clientSecret:
          host.env.APPROVAL_CLIENT_SECRET ?? host.env.AUTH0_CLIENT_SECRET,
        fetch: host.env.APPROVAL_FETCH,
      });
      const ledger = createPostgresApprovalLedger(host.conn.db, cfg, {
        table: "policy_desk.approval_requests",
      });
      const response = await handleApprovalRoute(req, cfg, {
        appName: "Policy Desk",
        store: ledger,
        deliver: async ({ request, proof }) =>
          ledger.deliver(request.id, proof),
      });
      return response ?? problem(404, "not_found", "Not found.");
    }
    if (p.startsWith("/sandbox/"))
      return sandboxApi(host, req, (r) => route(host, r));
    if (p === "/healthz") {
      await host.conn.store.ping();
      return json({ status: "ok", paymentsMode: "simulator" });
    }
    if (p === "/v1/refunds" || p.startsWith("/v1/refunds/")) {
      const r = await resolve(host, req);
      if (r instanceof Response) return r;
      const { sandbox, who } = r;
      if (p === "/v1/refunds" && req.method === "POST")
        return createRefund(host, sandbox, req, who);
      const m = p.match(/^\/v1\/refunds\/([A-Za-z0-9:_\-.]{1,200})(\/run)?$/);
      if (m && m[2] && req.method === "POST")
        return runRefund(host, sandbox, m[1]!);
      if (m && !m[2] && req.method === "GET")
        return getRefund(host, sandbox, m[1]!);
      return problem(405, "method_not_allowed", "Method not allowed.");
    }
    if (p.startsWith("/v1/")) {
      // The real Task Authority service, configured for the caller's own sandbox tenant.
      const sandbox = await sandboxFromBearer(host, req);
      const hasToken = !!req.headers.get("authorization");
      if (hasToken && !sandbox)
        return problem(
          404,
          "sandbox_not_initialized",
          "Your sandbox does not exist: it was never created, or it expired and was deleted.",
          {
            hint: "Create a new one with POST /sandbox/reset.",
            nextAction: "reset_sandbox",
          },
        );
      return serviceHandler(host, sandbox)(req);
    }
    if (p === "/mcp") return handleMcp(host, req);
    if (PRM_PATHS.includes(p) && req.method === "GET")
      return protectedResourceMetadata(host);
    if (p.startsWith("/.well-known/"))
      return problem(
        404,
        "not_available",
        "This endpoint is not part of the sandbox.",
        {
          hint: "POST /mcp with an Auth0 access token for the Task Authority audience.",
        },
      );
    return null as unknown as Response;
  }

  // The runtime role owns nothing and cannot run DDL; with MIGRATE_ON_REQUEST="false" the
  // schema is migrated out of band by tools/migrate.ts as the owner role.
  const migrate = (host: Host) =>
    host.env.MIGRATE_ON_REQUEST === "false"
      ? Promise.resolve()
      : ensureSchema(
          host.conn.client,
          opts.migrations,
          host.env.DATABASE_URL ?? "hyperdrive",
        );

  async function withHost<T>(
    env: Env,
    req: Request,
    fn: (h: Host) => Promise<T>,
    waitUntil?: (p: Promise<unknown>) => void,
  ) {
    const host = await openHost(env, req, deps);
    let streaming = false;
    try {
      await migrate(host);
      const out = await fn(host);
      // A streamed response keeps using the connection until its last event.
      if (host.streaming) {
        streaming = true;
        const done = host.streaming.finally(() => host.conn.close());
        waitUntil?.(done);
      }
      return out;
    } finally {
      if (!streaming) await host.conn.close();
    }
  }

  return {
    async fetch(
      req: Request,
      env: Env,
      ctx?: { waitUntil(p: Promise<unknown>): void },
    ): Promise<Response> {
      const p = new URL(req.url).pathname;
      const dynamic =
        p.startsWith("/sandbox/") ||
        p.startsWith("/v1/") ||
        p === "/healthz" ||
        p === "/mcp" ||
        p === "/approve" ||
        p.startsWith("/approve/") ||
        p.startsWith("/.well-known/");
      if (!dynamic) {
        if (env.ASSETS) return env.ASSETS.fetch(req);
        return problem(404, "no_assets", "Static assets are not bound.");
      }
      if (
        env.EDGE_LIMIT &&
        (p.startsWith("/sandbox/") || p.startsWith("/v1/"))
      ) {
        const ip = req.headers.get("cf-connecting-ip") ?? "local";
        const { success } = await env.EDGE_LIMIT.limit({ key: ip });
        if (!success)
          return problem(429, "rate_limited", "Too many requests.", {
            retryAfterSec: 60,
          });
      }
      try {
        const started = Date.now();
        let timings: Timings | undefined;
        const res = await withHost(
          env,
          req,
          (h) => {
            timings = h.conn.timings;
            return route(h, req);
          },
          ctx ? (p) => ctx.waitUntil(p) : undefined,
        );
        if (!res) return problem(404, "not_found", "Not found.");
        return withServerTiming(res, timings, Date.now() - started);
      } catch (e) {
        if (e instanceof ConfigError)
          return problem(
            503,
            "not_configured",
            "The sandbox is not fully configured.",
            {
              hint: e.message,
              nextAction: "contact_operator",
            },
          );
        if (e instanceof LimitExceeded)
          return problem(429, "rate_limited", "Too many requests.", {
            retryAfterSec: e.retryAfterSec,
          });
        console.error(
          JSON.stringify({
            event: "unhandled",
            type: e instanceof Error ? e.name : "unknown",
            message: e instanceof Error ? e.message : "",
          }),
        );
        return problem(
          503,
          "dependency_unavailable",
          "Something we depend on is unavailable. Nothing was authorized.",
          {
            nextAction: "retry_later",
          },
        );
      }
    },
    async scheduled(env: Env) {
      const host = await openHost(
        env,
        new Request("https://scheduled.invalid/"),
        deps,
      );
      try {
        await migrate(host);
        const out = await cleanupExpired(host);
        console.log(JSON.stringify({ event: "cleanup", ...out }));
        return out;
      } finally {
        await host.conn.close();
      }
    },
  };
}
