import type { McpAuthenticator } from "./auth.js";
import {
  renderRest,
  stepUpChallenge,
  type OperationView,
} from "@task-authority/sdk";
import { AuthRequired } from "./auth.js";
import { handleMcp } from "./mcp.js";
import type { SimulatedPayments } from "./payments.js";
import type { Repository } from "./repository.js";
import type { ReviewerBackend } from "./reviewer.js";
import { AppError, type RefundService } from "./tasks.js";
import { signWarehouseBody, verifyWarehouseRequest } from "./warehouse.js";

export type OperatorFixtures = {
  /** Demo-only FGA fixture mutation (e.g. "manager loses access"). Labelled in the UI. */
  setPermission?: (
    user: string,
    relation: string,
    org: string,
    granted: boolean,
  ) => Promise<void>;
};
export type AppDeps = {
  service: RefundService;
  repo: Repository;
  authn: McpAuthenticator;
  warehouseSecret: string;
  now: () => number;
  providerMode: string;
  publicConfig: Record<string, string>;
  reviewer?: ReviewerBackend;
  providerWebhook?: (request: Request) => Promise<Response>;
  /** Present only when DEMO_MODE=1. Never mounted otherwise. */
  operator?: {
    token: string;
    simulator?: SimulatedPayments;
    fixtures?: OperatorFixtures;
  };
};

/** Constant-time comparison of equal-length SHA-256 digests (hides the secret's length too). */
async function safeEqual(a: string, b: string) {
  const h = async (x: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)),
    );
  const [x, y] = await Promise.all([h(a), h(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });

export function createApp(d: AppDeps) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/healthz")
        return await d.repo.ping().then(
          () =>
            json({
              status: "ok",
              providerMode: d.providerMode,
              demoMode: Boolean(d.operator),
            }),
          () => json({ status: "unavailable" }, 503),
        );
      if (url.pathname === "/.well-known/oauth-protected-resource")
        return json(d.authn.metadata());
      if (url.pathname === "/api/config") return json(d.publicConfig);
      if (url.pathname === "/api/provider/refunds" && req.method === "POST")
        return d.providerWebhook
          ? await d.providerWebhook(req)
          : json({ error: "not_found" }, 404);
      if (url.pathname.startsWith("/api/reviewer/"))
        return d.reviewer
          ? await d.reviewer.handle(req)
          : json({ error: "reviewer_par_not_configured" }, 404);
      if (url.pathname === "/v1/refunds" && req.method === "POST") {
        const p = await d.authn.authenticate(req);
        const task = await d.service.create(
          p,
          await req.json().catch(() => null),
        );
        return renderRest(await d.service.transportOutcome(task));
      }
      const operation = url.pathname.match(/^\/v1\/operations\/([^/]+)$/);
      if (operation && req.method === "GET") {
        const p = await d.authn.authenticate(req);
        return json(
          await d.service.operationStatus(p, decodeURIComponent(operation[1]!)),
        );
      }
      if (url.pathname === "/mcp")
        return handleMcp(req, {
          service: d.service,
          authn: d.authn,
          serverName: "refund-desk",
          providerMode: d.providerMode,
        });

      if (url.pathname === "/api/warehouse/events" && req.method === "POST") {
        const body = await req.text();
        const event = await verifyWarehouseRequest(
          d.warehouseSecret,
          req.headers.get("x-warehouse-signature"),
          body,
          d.now(),
        );
        // One uniform refusal: no oracle for signature vs. schema vs. skew.
        if (!event) return json({ error: "invalid_warehouse_event" }, 401);
        const r = await d.repo.recordWarehouseEvent({
          eventId: event.eventId,
          orgId: event.orgId,
          orderId: event.orderId,
          paymentId: event.paymentId,
          reference: event.reference,
        });
        return json(
          {
            accepted: true,
            duplicate: r.duplicate,
            matchedTask: Boolean(r.task),
          },
          r.duplicate ? 200 : 202,
        );
      }

      const tl = url.pathname.match(
        /^\/api\/tasks\/([0-9a-f-]{36})\/timeline$/,
      );
      if (tl && req.method === "GET") {
        const p = await d.authn.authenticate(req);
        return json({ events: await d.service.timeline(p, tl[1]!) });
      }

      if (url.pathname.startsWith("/operator/"))
        return await operator(d, req, url);
      return json({ error: "not_found" }, 404);
    } catch (e) {
      if (e instanceof AuthRequired)
        return json({ error: e.code }, 401, {
          "www-authenticate": d.authn.challenge(e.code),
        });
      if (e instanceof AppError)
        return json(
          { error: e.code, ...e.data },
          e.status,
          e.status === 401 && e.code === "insufficient_user_authentication"
            ? {
                "www-authenticate": stepUpChallenge(
                  (e.data?.operation ?? {}) as OperationView,
                ),
              }
            : {},
        );
      console.error(
        JSON.stringify({
          event: "request_failed",
          type: e instanceof Error ? e.name : "unknown",
        }),
      );
      return json({ error: "dependency_unavailable" }, 503);
    }
  };
}

/** Operator-only demo controls. Authenticated, never public, and labelled as fixtures. */
async function operator(d: AppDeps, req: Request, url: URL): Promise<Response> {
  const op = d.operator;
  if (!op) return json({ error: "not_found" }, 404); // not mounted outside demo mode
  const given =
    req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  if (!(await safeEqual(given, op.token)))
    return json({ error: "operator_token_required" }, 401);
  const body =
    req.method === "POST"
      ? ((await req.json().catch(() => ({}))) as Record<string, any>)
      : {};
  switch (url.pathname) {
    case "/operator/worker/run":
      await d.service.runDue();
      return json({ ran: true });
    case "/operator/task": {
      // Fixture view for the "Inspect security" panel: task state plus the correlated timeline.
      const id = url.searchParams.get("taskId") ?? "";
      return json(await d.service.operatorView(id));
    }
    case "/operator/revoke": {
      const t = await d.repo.get(String(body.taskId));
      if (!t?.delegationId) return json({ error: "task_not_found" }, 404);
      return json({
        fixture: true,
        delegation: await d.service.o.authority.delegations.revoke(
          t.delegationId,
          { reason: "operator_scenario" },
        ),
      });
    }
    case "/operator/faults":
      if (!op.simulator) return json({ error: "simulator_only" }, 409);
      op.simulator.faults = { ...body };
      return json({ faults: op.simulator.faults });
    case "/operator/warehouse-event": {
      // FIXTURE: server-side shortcut that signs a synthetic event with the real secret.
      const payload = JSON.stringify({
        eventId: `evt_${crypto.randomUUID()}`,
        type: "return.received",
        orgId: body.orgId,
        orderId: body.orderId,
        paymentId: body.paymentId,
        reference: `SYNTHETIC-${body.orderId}`,
      });
      const sig = await signWarehouseBody(
        d.warehouseSecret,
        payload,
        Math.floor(d.now() / 1000),
      );
      const r = await d.repo.recordWarehouseEvent(JSON.parse(payload));
      void sig;
      return json({
        fixture: true,
        duplicate: r.duplicate,
        matchedTask: Boolean(r.task),
      });
    }
    case "/operator/permission":
      if (!op.fixtures?.setPermission)
        return json({ error: "fixture_unavailable" }, 409);
      await op.fixtures.setPermission(
        String(body.user),
        String(body.relation),
        String(body.org),
        Boolean(body.granted),
      );
      return json({ fixture: true, applied: true });
    default:
      return json({ error: "not_found" }, 404);
  }
}
