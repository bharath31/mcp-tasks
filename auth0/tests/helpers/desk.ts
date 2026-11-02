import type { AddressInfo } from "node:net";
import { TaskAuthority } from "@task-authority/sdk";
import { createApp } from "../../../demo/refund-desk/src/app.js";
import { McpAuthenticator } from "../../../demo/refund-desk/src/auth.js";
import { SimulatedPayments } from "../../../demo/refund-desk/src/payments.js";
import { NORTHSTAR_POLICY } from "../../../demo/refund-desk/src/policy.js";
import { Repository } from "../../../demo/refund-desk/src/repository.js";
import { RefundService } from "../../../demo/refund-desk/src/tasks.js";
import { signWarehouseBody } from "../../../demo/refund-desk/src/warehouse.js";
import { listen } from "../../service/src/server.js";
import { createTestDb } from "./pg.js";
import { createWorld, ORG, PEOPLE, type World } from "./world.js";
import pg from "pg";

export const MCP_AUDIENCE = "https://refund-desk.test/mcp";
export const MCP_CLIENT = "client_mcp_returns_agent";
export const MCP_CLIENT_SOUTHRIDGE = "client_mcp_returns_agent_sr";
export const WAREHOUSE_SECRET = "test-warehouse-secret-0123456789";
export const OPERATOR_TOKEN = "operator-token-for-tests";
const DOMAIN = "test-tenant.example";

/** Serves OIDC discovery + JWKS for @auth0/auth0-api-js without touching a real tenant. */
function oidcFetch(w: World): typeof fetch {
  return async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url,
    );
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), {
        headers: { "content-type": "application/json" },
      });
    if (
      url.pathname.endsWith("/.well-known/openid-configuration") ||
      url.pathname.endsWith("/.well-known/oauth-authorization-server")
    )
      return json({
        issuer: `https://${DOMAIN}/`,
        jwks_uri: `https://${DOMAIN}/.well-known/jwks.json`,
        token_endpoint: `https://${DOMAIN}/oauth/token`,
        authorization_endpoint: `https://${DOMAIN}/authorize`,
      });
    if (url.pathname.endsWith("/jwks.json")) return json({ keys: [w.idp.jwk] });
    return new Response("not found", { status: 404 });
  };
}

export async function seedDeskPolicy(
  pool: pg.Pool,
  tenantId: string,
  resourceServer = MCP_AUDIENCE,
  now = Date.now(),
) {
  // Approval thresholds are service policy, shared by MCP, REST and CLI.
  const document = {
    resource_server: resourceServer,
    version: "desk-policy-v1",
    unknown_action: "deny",
    actions: {
      "refund:create": {
        arguments: { amountMinor: "int", currency: "string" },
        requester_relation: "refund_request",
        approvers: { relation: "refund_approve", on: "organization" },
        rules: [
          {
            id: "over-100",
            when: "args.amountMinor > 10000",
            then: { approve: { tier: "routine", ttl: "30m" } },
          },
        ],
        default: { allow: {} },
      },
    },
    tiers: {
      routine: {
        assurance: "per_operation",
        max_age: 300,
        factors: ["webauthn-platform", "webauthn-roaming", "otp"],
      },
    },
  };
  await pool.query(
    "insert into authority.policy_versions(tenant_id,resource_server,version,document,created_by,created_at) values($1,$2,$3,$4,'fixture',$5) on conflict do nothing",
    [
      tenantId,
      resourceServer,
      document.version,
      JSON.stringify(document),
      new Date(now).toISOString(),
    ],
  );
  await pool.query(
    "insert into authority.policy_state(tenant_id,resource_server,active_version) values($1,$2,$3) on conflict(tenant_id,resource_server) do update set active_version=excluded.active_version",
    [tenantId, resourceServer, document.version],
  );
}

export async function createDesk(world?: World) {
  const w = world ?? (await createWorld());
  const authorityServer = await listen(w.handle, 0);
  const baseUrl = `http://127.0.0.1:${(authorityServer.address() as AddressInfo).port}`;
  const db = await createTestDb("rd");
  const repo = new Repository(
    new pg.Pool({ connectionString: db.url, max: 8 }),
    w.clock.now,
  );
  await repo.migrate();
  await seedDeskPolicy(
    w.store.pool,
    w.tenant.tenantId,
    MCP_AUDIENCE,
    w.clock.now(),
  );
  const payments = new SimulatedPayments(repo.pool, w.clock.now);
  const sdk = (role: "api" | "executor" | "investigator") =>
    new TaskAuthority({
      baseUrl,
      getAccessToken: () => w.tok[role](),
      retry: { baseDelayMs: 5, maxDelayMs: 20 },
    });
  const authority = sdk("api");
  const executor = sdk("executor");
  const auditor = sdk("investigator");
  const authn = new McpAuthenticator({
    domain: DOMAIN,
    audience: MCP_AUDIENCE,
    resource: "https://refund-desk.test",
    customFetch: oidcFetch(w),
    agentByClient: {
      [MCP_CLIENT]: "agent_returns",
      [MCP_CLIENT_SOUTHRIDGE]: "agent_returns_sr",
    },
    humanClientIds: ["refund_cli_human"],
    authorityAudience: w.idp.audience,
    // Stand-in for Auth0 on-behalf-of exchange: a token for the authority audience, same subject.
    exchange: (p) => w.idp.mint({ sub: p.sub, orgId: p.orgId }),
  });
  const service = new RefundService({
    resourceServer: MCP_AUDIENCE,
    authority,
    executor,
    auditor,
    payments,
    policy: NORTHSTAR_POLICY,
    now: w.clock.now,
    repo,
    subjectToken: (p) => authn.subjectToken(p),
    reviewUrl: (id, org) =>
      `https://refund-desk.test/review.html?approval=${id}&org=${org}`,
    providerMode: payments.mode,
  });
  const permissions: Array<[string, string, string, boolean]> = [];
  const app = createApp({
    service,
    repo,
    authn,
    warehouseSecret: WAREHOUSE_SECRET,
    now: w.clock.now,
    providerMode: payments.mode,
    publicConfig: { providerMode: payments.mode },
    operator: {
      token: OPERATOR_TOKEN,
      simulator: payments,
      fixtures: {
        setPermission: async (u, r, o, g) => {
          permissions.push([u, r, o, g]);
          await (g ? w.fga.write : w.fga.delete)([
            { user: u, relation: r, object: `organization:${o}` },
          ]);
        },
      },
    },
  });

  /** Token as issued by Auth0 for the MCP resource (iat is real time: the SDK uses the wall clock). */
  const mcpToken = (sub: string, orgId: string, o: { client?: string } = {}) =>
    w.idp.mint({
      sub,
      orgId,
      azp: o.client ?? MCP_CLIENT,
      audience: MCP_AUDIENCE,
      iat: Math.floor(Date.now() / 1000),
    });

  /** Deterministic compliant MCP 2026-07-28 test client (per-request framing). */
  async function rpc(
    method: string,
    params: Record<string, unknown> = {},
    o: {
      token?: string;
      tasks?: boolean;
      version?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const meta: Record<string, unknown> = {
      "io.modelcontextprotocol/protocolVersion": o.version ?? "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "test-client",
        version: "1.0.0",
      },
    };
    meta["io.modelcontextprotocol/clientCapabilities"] =
      o.tasks === false
        ? {}
        : { extensions: { "io.modelcontextprotocol/tasks": {} } };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "mcp-protocol-version": o.version ?? "2026-07-28",
      "mcp-method": method,
      ...o.headers,
    };
    if (typeof params.taskId === "string" && !headers["mcp-name"])
      headers["mcp-name"] = params.taskId;
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    const res = await app(
      new Request("https://refund-desk.test/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: { ...params, _meta: meta },
        }),
      }),
    );
    return {
      status: res.status,
      headers: res.headers,
      body: (await res.json()) as any,
    };
  }

  const alice = () => mcpToken(PEOPLE.alice, ORG.northstar);
  const refund = async (o: {
    amountMinor?: number;
    paymentId: string;
    orderId?: string;
    note?: string;
    token?: string;
    currency?: string;
  }) =>
    rpc(
      "tools/call",
      {
        name: "request_refund",
        arguments: {
          orderId: o.orderId ?? "742",
          paymentId: o.paymentId,
          amountMinor: o.amountMinor ?? 15000,
          currency: o.currency ?? "USD",
          reason: "Customer returned the item",
          ...(o.note ? { exceptionNote: o.note } : {}),
        },
      },
      { token: o.token ?? (await alice()) },
    );

  const desk = {
    w,
    repo,
    payments,
    service,
    app,
    authority,
    executor,
    authn,
    rpc,
    mcpToken,
    alice,
    refund,
    db,
    permissions,
    baseUrl,
    /** A paid $300.00 order for Northstar. */
    async payment(amountMinor = 30000) {
      return payments.createPayment(ORG.northstar, amountMinor, "USD");
    },
    async warehouse(
      orderId: string,
      paymentId: string,
      o: {
        eventId?: string;
        secret?: string;
        ts?: number;
        tamper?: boolean;
        org?: string;
      } = {},
    ) {
      const body = JSON.stringify({
        eventId: o.eventId ?? `evt_${crypto.randomUUID()}`,
        type: "return.received",
        orgId: o.org ?? ORG.northstar,
        orderId,
        paymentId,
        reference: "SYNTHETIC-RMA-1",
      });
      const sig = await signWarehouseBody(
        o.secret ?? WAREHOUSE_SECRET,
        body,
        o.ts ?? Math.floor(w.clock.now() / 1000),
      );
      const res = await app(
        new Request("https://refund-desk.test/api/warehouse/events", {
          method: "POST",
          headers: {
            "x-warehouse-signature": sig,
            "content-type": "application/json",
          },
          body: o.tamper ? body.replace(orderId, `${orderId}X`) : body,
        }),
      );
      return { status: res.status, body: (await res.json()) as any };
    },
    async tick(times = 1) {
      for (let i = 0; i < times; i++) await service.runDue();
    },
    /** Poll tasks/get like a client would. */
    async get(taskId: string, token?: string) {
      const r = await rpc(
        "tasks/get",
        { taskId },
        { token: token ?? (await alice()) },
      );
      return r.body.result ?? r.body.error;
    },
    /** Advance the controlled clock and let the worker run. */
    async step(ms = 0) {
      w.clock.advance(ms);
      await service.runDue();
    },
    async close() {
      authorityServer.close();
      await repo.close();
      await db.drop();
      await w.close();
    },
  };
  return desk;
}
export type Desk = Awaited<ReturnType<typeof createDesk>>;
