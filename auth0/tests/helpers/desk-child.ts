// Runs the customer app as a REAL separate process for restart tests. It talks
// to the Task Authority service only over HTTP and shares nothing in memory.
import { TaskAuthority } from "@task-authority/sdk";
import type { JWK } from "jose";
import pg from "pg";
import { createApp } from "../../../demo/refund-desk/src/app.js";
import { McpAuthenticator } from "../../../demo/refund-desk/src/auth.js";
import { SimulatedPayments } from "../../../demo/refund-desk/src/payments.js";
import { NORTHSTAR_POLICY } from "../../../demo/refund-desk/src/policy.js";
import { Repository } from "../../../demo/refund-desk/src/repository.js";
import { RefundService } from "../../../demo/refund-desk/src/tasks.js";
import { listen } from "../../service/src/server.js";
import { Clock } from "./clock.js";
import { CLIENTS, PERMISSIONS } from "../../fixtures/index.js";
import { TestIdp } from "./idp.js";

const env = (k: string) =>
  process.env[k] ??
  (() => {
    throw new Error(`missing ${k}`);
  })();
const realClock = {
  now: () => Date.now(),
  get seconds() {
    return Math.floor(Date.now() / 1000);
  },
} as unknown as Clock;
const idp = await TestIdp.restore(
  JSON.parse(env("IDP_PRIVATE_JWK")) as JWK,
  JSON.parse(env("IDP_PUBLIC_JWK")) as JWK,
  realClock,
);
const baseUrl = env("AUTHORITY_URL");
const repo = new Repository(
  new pg.Pool({ connectionString: env("DESK_DB_URL"), max: 6 }),
  Date.now,
);
const payments = new SimulatedPayments(repo.pool, Date.now);
const sdk = (id: string, perms: readonly string[]) =>
  new TaskAuthority({
    baseUrl,
    getAccessToken: () => idp.service(id, perms),
    retry: { baseDelayMs: 20, maxDelayMs: 100 },
  });
const oidc: typeof fetch = async (input) => {
  const u = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url,
  );
  const j = (b: unknown) =>
    new Response(JSON.stringify(b), {
      headers: { "content-type": "application/json" },
    });
  if (
    u.pathname.endsWith("openid-configuration") ||
    u.pathname.endsWith("oauth-authorization-server")
  )
    return j({
      issuer: idp.issuer,
      jwks_uri: `${idp.issuer}.well-known/jwks.json`,
      token_endpoint: `${idp.issuer}oauth/token`,
    });
  return j({ keys: [idp.jwk] });
};
const authn = new McpAuthenticator({
  domain: "test-tenant.example",
  audience: env("MCP_AUDIENCE"),
  resource: "https://refund-desk.test",
  customFetch: oidc,
  agentByClient: { client_mcp_returns_agent: "agent_returns" },
  authorityAudience: idp.audience,
  exchange: (p) => idp.mint({ sub: p.sub, orgId: p.orgId }),
});
const service = new RefundService({
  resourceServer: env("MCP_AUDIENCE"),
  authority: sdk(CLIENTS.api, PERMISSIONS.api),
  executor: sdk(CLIENTS.executor, PERMISSIONS.executor),
  auditor: sdk(CLIENTS.investigator, PERMISSIONS.investigator),
  payments,
  policy: NORTHSTAR_POLICY,
  now: Date.now,
  repo,
  subjectToken: (p) => authn.subjectToken(p),
  reviewUrl: (id, org) =>
    `https://refund-desk.test/review.html?approval=${id}&org=${org}`,
  providerMode: payments.mode,
});
const app = createApp({
  service,
  repo,
  authn,
  warehouseSecret: env("WAREHOUSE_SECRET"),
  now: Date.now,
  providerMode: payments.mode,
  publicConfig: {},
});
setInterval(() => service.runDue().catch(() => undefined), 150).unref();
const server = await listen(app, 0);
console.log(
  JSON.stringify({
    ready: true,
    port: (server.address() as { port: number }).port,
  }),
);
