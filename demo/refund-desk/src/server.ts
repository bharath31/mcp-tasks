// Node entrypoint for the customer app. Run the Task Authority service separately.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskAuthority } from "@task-authority/sdk";
import { createApp } from "./app.js";
import { McpAuthenticator } from "./auth.js";
import {
  SimulatedPayments,
  StripeTestPayments,
  type Payments,
} from "./payments.js";
import { NORTHSTAR_POLICY } from "./policy.js";
import { Repository } from "./repository.js";
import { RefundService } from "./tasks.js";
import { ReviewerBackend } from "./reviewer.js";
import { stripeRefundWebhook } from "./provider-webhook.js";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required environment variable ${k}`);
  return v;
};

/** Machine-to-machine token provider (Auth0 client credentials) for one SDK role. */
function m2m(clientIdVar: string, clientSecretVar: string) {
  let cache: { token: string; exp: number } | null = null;
  return async () => {
    if (cache && cache.exp > Date.now() + 30_000) return cache.token;
    const res = await fetch(`https://${need("AUTH0_DOMAIN")}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: need(clientIdVar),
        client_secret: need(clientSecretVar),
        audience: need("TASK_AUTHORITY_AUDIENCE"),
      }),
    });
    if (!res.ok) throw new Error("m2m_token_failed");
    const j = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    cache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return cache.token;
  };
}

export async function buildFromEnv() {
  const repo = Repository.connect(need("REFUND_DESK_DATABASE_URL"));
  await repo.migrate();
  const mode = process.env.PAYMENTS_MODE ?? "simulator";
  let simulator: SimulatedPayments | undefined;
  let payments: Payments;
  if (mode === "stripe-test")
    payments = new StripeTestPayments(need("STRIPE_SECRET_KEY"));
  else payments = simulator = new SimulatedPayments(repo.pool);
  const baseUrl = need("TASK_AUTHORITY_URL");
  const authority = new TaskAuthority({
    baseUrl,
    getAccessToken: m2m(
      "AUTHORITY_API_CLIENT_ID",
      "AUTHORITY_API_CLIENT_SECRET",
    ),
  });
  const executor = new TaskAuthority({
    baseUrl,
    getAccessToken: m2m(
      "AUTHORITY_EXECUTOR_CLIENT_ID",
      "AUTHORITY_EXECUTOR_CLIENT_SECRET",
    ),
  });
  const auditor = process.env.AUTHORITY_AUDITOR_CLIENT_ID
    ? new TaskAuthority({
        baseUrl,
        getAccessToken: m2m(
          "AUTHORITY_AUDITOR_CLIENT_ID",
          "AUTHORITY_AUDITOR_CLIENT_SECRET",
        ),
      })
    : undefined;
  const publicUrl = need("PUBLIC_URL");
  const authn = new McpAuthenticator({
    domain: need("AUTH0_DOMAIN"),
    audience: need("MCP_AUDIENCE"),
    resource: publicUrl,
    agentByClient: JSON.parse(need("AGENT_BY_CLIENT_JSON")),
    humanClientIds: JSON.parse(process.env.HUMAN_CLIENT_IDS_JSON ?? "[]"),
    clientId: process.env.MCP_RESOURCE_CLIENT_ID,
    clientSecret: process.env.MCP_RESOURCE_CLIENT_SECRET,
    authorityAudience: need("TASK_AUTHORITY_AUDIENCE"),
  });
  const service = new RefundService({
    resourceServer: need("MCP_AUDIENCE"),
    authority,
    executor,
    auditor,
    payments,
    policy: NORTHSTAR_POLICY,
    now: Date.now,
    repo,
    subjectToken: (p) => authn.subjectToken(p),
    reviewUrl: (id, org) =>
      `${publicUrl}/review.html?approval=${id}&org=${encodeURIComponent(org)}`,
    providerMode: payments.mode,
    ownerPrompt:
      process.env.OWNER_APPROVAL_PROMPT === "status" ? "status" : "elicitation",
  });
  const demo = process.env.DEMO_MODE === "1";
  const app = createApp({
    service,
    repo,
    authn,
    warehouseSecret: need("WAREHOUSE_SIGNING_SECRET"),
    now: Date.now,
    providerMode: payments.mode,
    reviewer:
      process.env.REVIEWER_PAR_ENABLED === "1"
        ? new ReviewerBackend({
            domain: need("AUTH0_DOMAIN"),
            clientId: need("REVIEWER_BACKEND_CLIENT_ID"),
            clientSecret: need("REVIEWER_BACKEND_CLIENT_SECRET"),
            audience: need("TASK_AUTHORITY_AUDIENCE"),
            publicUrl,
            authority,
          })
        : undefined,
    providerWebhook: process.env.STRIPE_WEBHOOK_SIGNING_SECRET
      ? stripeRefundWebhook({
          signingSecret: need("STRIPE_WEBHOOK_SIGNING_SECRET"),
          organizationId: need("STRIPE_ORGANIZATION_ID"),
          authority,
        })
      : undefined,
    publicConfig: {
      auth0Domain: need("AUTH0_DOMAIN"),
      reviewerClientId: process.env.REVIEWER_CLIENT_ID ?? "",
      authorityUrl: baseUrl,
      authorityAudience: need("TASK_AUTHORITY_AUDIENCE"),
      providerMode: payments.mode,
      demoMode: String(demo),
      reviewerParEnabled: String(process.env.REVIEWER_PAR_ENABLED === "1"),
    },
    operator: demo ? { token: need("OPERATOR_TOKEN"), simulator } : undefined,
  });
  return { app, service, repo };
}

/** Reads at most `limit` bytes; returns null (without buffering the rest) when exceeded. */
async function readLimited(
  req: import("node:http").IncomingMessage,
  limit: number,
) {
  if (Number(req.headers["content-length"] ?? 0) > limit) return null;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const MAX_REQUEST_BYTES = 256 * 1024;

const WEB = fileURLToPath(new URL("../web/dist/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** Node adapter for the app handler: static pages, bounded bodies, Web-standard Request/Response. */
export function serveApp(
  app: (r: Request) => Promise<Response>,
  port: number,
  host = "127.0.0.1",
) {
  return createServer(async (req, res) => {
    const body = await readLimited(req, MAX_REQUEST_BYTES);
    if (body === null) {
      res.writeHead(413, {
        "content-type": "application/json",
        connection: "close",
      });
      return void res.end(JSON.stringify({ error: "request_too_large" }));
    }
    const u = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (
      req.method === "GET" &&
      !/^\/(mcp|api|v1|operator|healthz|\.well-known)/.test(u.pathname)
    ) {
      const rel = normalize(
        u.pathname === "/" ? "/index.html" : u.pathname,
      ).replace(/^(\.\.[/\\])+/, "");
      try {
        const file = await readFile(join(WEB, rel));
        res.writeHead(200, {
          "content-type": TYPES[extname(rel)] ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
        });
        return void res.end(file);
      } catch {
        res.writeHead(404);
        return void res.end("not found");
      }
    }
    const r = await app(
      new Request(u, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : body,
      }),
    );
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(port, host);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, service } = await buildFromEnv();
  setInterval(
    () => service.runDue().catch(() => undefined),
    Number(process.env.WORKER_INTERVAL_MS ?? 5000),
  ).unref();
  const server = serveApp(
    app,
    Number(process.env.PORT ?? 8787),
    process.env.HOST ?? "0.0.0.0",
  );
  server.on("listening", () =>
    console.log(JSON.stringify({ event: "listening", app: "refund-desk" })),
  );
}
