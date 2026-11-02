// Full-stack harness: REAL processes (service, customer app) over real HTTP, real Postgres
// databases, a real FGA engine (OpenFGA binary if OPENFGA_BIN, else an OpenFGA-API fake), and a
// LOCAL OIDC provider over HTTPS. Nothing here is Auth0; see oidc-server.ts.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // this (test) process only; children verify TLS against the provider's CA
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import pg from "pg";
import {
  ACTION_POLICIES,
  BASE_TUPLES,
  CLIENTS,
  ORG,
  PEOPLE,
  PERMISSIONS,
} from "@task-authority/test-fixtures";
import { signWarehouseBody } from "../../../demo/refund-desk/src/warehouse.js";
import { startFakeFgaServer } from "./fga-http-fake.js";
import { startOpenFga } from "./fga.js";
import { startOidcServer, MFA_CODE, type OidcServer } from "./oidc-server.js";
import { createTestDb } from "./pg.js";
import { seedDeskPolicy } from "./desk.js";

export const MCP_AUD = "https://refund-desk.local/mcp";
export const AUTHORITY_AUD = "https://task-authority.local/api";
export const WAREHOUSE_SECRET = "fullstack-warehouse-secret-0123456789";
export const OPERATOR_TOKEN = "fullstack-operator-token";
export const CIBA_CLIENT = "authority_ciba";
export const MCP_CLIENT = "mcp_client";
export const MCP_CLIENT_SR = "mcp_client_sr";
export const REVIEWER_SPA = "reviewer_spa";
const ROOT = new URL("../../../", import.meta.url).pathname;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });

export type Proc = {
  child: ChildProcess;
  port: number;
  url: string;
  log: string[];
  kill(): Promise<void>;
};

async function spawnNode(
  script: string,
  env: Record<string, string>,
  port: number,
): Promise<Proc> {
  const base = { ...process.env, ...env } as Record<string, string | undefined>;
  delete base.NODE_TLS_REJECT_UNAUTHORIZED;
  const child = spawn("node", ["--import", "tsx", script], {
    cwd: ROOT,
    env: base as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  const collect = (b: Buffer) =>
    log.push(...b.toString().split("\n").filter(Boolean));
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${script} did not start:\n${log.join("\n")}`)),
      30_000,
    );
    child.once("exit", (code) =>
      reject(new Error(`${script} exited early (${code}):\n${log.join("\n")}`)),
    );
    const check = () => {
      if (log.some((l) => l.includes('"listening"'))) {
        clearTimeout(t);
        resolve();
      }
    };
    child.stdout!.on("data", check);
    check();
  });
  return {
    child,
    port,
    url: `http://127.0.0.1:${port}`,
    log,
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.removeAllListeners("exit");
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    },
  };
}

export type Stack = Awaited<ReturnType<typeof startStack>>;

export async function startStack() {
  spawnSync("node", ["demo/tools/build-web.mjs"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const appPort = await freePort();
  const servicePort = await freePort();
  const appOrigin = `http://127.0.0.1:${appPort}`;

  const users = [
    {
      key: "alice",
      sub: PEOPLE.alice,
      name: "Alice (Northstar support)",
      org: ORG.northstar,
    },
    {
      key: "morgan",
      sub: PEOPLE.morgan,
      name: "Morgan (Northstar manager)",
      org: ORG.northstar,
    },
    {
      key: "eve",
      sub: PEOPLE.eve,
      name: "Eve (Northstar member)",
      org: ORG.northstar,
    },
    {
      key: "mallory",
      sub: PEOPLE.mallory,
      name: "Mallory (Southridge manager)",
      org: ORG.southridge,
    },
    {
      key: "sam",
      sub: PEOPLE.sam,
      name: "Sam (Southridge support)",
      org: ORG.southridge,
    },
  ];
  const m2m = (id: string, perms: readonly string[]) => ({
    id,
    secret: `${id}-secret`,
    permissions: [...perms],
  });
  const oidc: OidcServer = await startOidcServer({
    users,
    clients: [
      m2m(CLIENTS.api, PERMISSIONS.api),
      m2m(CLIENTS.executor, PERMISSIONS.executor),
      m2m(CLIENTS.investigator, PERMISSIONS.investigator),
      { id: "mcp_resource", secret: "mcp-resource-secret" },
      { id: CIBA_CLIENT, secret: "ciba-secret" },
      { id: MCP_CLIENT, redirectUris: ["http://127.0.0.1:1/cb"] },
      { id: MCP_CLIENT_SR, redirectUris: ["http://127.0.0.1:1/cb"] },
      { id: REVIEWER_SPA, redirectUris: [`${appOrigin}/review.html`] },
    ],
    resourceAudiences: [MCP_AUD, AUTHORITY_AUD],
  });

  const fgaServer = process.env.OPENFGA_BIN
    ? await startOpenFga(process.env.OPENFGA_BIN)
    : await startFakeFgaServer();
  const fgaAdmin = "fga" in fgaServer ? fgaServer.fga : fgaServer;
  await fgaAdmin.write(BASE_TUPLES);

  const serviceDb = await createTestDb("ta");
  const appDb = await createTestDb("rd");
  const caEnv = { NODE_EXTRA_CA_CERTS: oidc.caPath };

  const tenantJson = JSON.stringify([
    {
      tenantId: "tnt_demo",
      issuer: oidc.issuer,
      audience: AUTHORITY_AUD,
      fga: {
        apiUrl: fgaServer.apiUrl,
        storeId: fgaServer.storeId,
        modelId: fgaServer.modelId,
      },
      actions: ACTION_POLICIES,
      ciba: {
        bcAuthorizeUrl: `${oidc.issuer}bc-authorize`,
        tokenUrl: `${oidc.issuer}oauth/token`,
        clientId: CIBA_CLIENT,
        clientSecret: "ciba-secret",
      },
    },
    // A second configured tenant (never used) proves multi-tenant configuration loads.
    {
      tenantId: "tnt_other",
      issuer: "https://other-tenant.invalid/",
      audience: AUTHORITY_AUD,
      fga: {
        apiUrl: fgaServer.apiUrl,
        storeId: fgaServer.storeId,
        modelId: fgaServer.modelId,
      },
      actions: ACTION_POLICIES,
    },
  ]);
  const serviceEnv = {
    ...caEnv,
    TASK_AUTHORITY_DATABASE_URL: serviceDb.url,
    MIGRATE_ON_START: "1",
    TENANTS_JSON: tenantJson,
    ALLOWED_ORIGINS: appOrigin,
    PORT: String(servicePort),
    HOST: "127.0.0.1",
  };
  let service = await spawnNode(
    "auth0/service/src/server.ts",
    serviceEnv,
    servicePort,
  );
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const policyPool = new pg.Pool({ connectionString: serviceDb.url, max: 1 });
  try {
    await seedDeskPolicy(policyPool, "tnt_demo", MCP_AUD);
  } finally {
    await policyPool.end();
  }

  const appEnvBase = (port: number, extra: Record<string, string> = {}) => ({
    ...caEnv,
    REFUND_DESK_DATABASE_URL: appDb.url,
    PAYMENTS_MODE: "simulator",
    TASK_AUTHORITY_URL: serviceUrl,
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    AUTH0_DOMAIN: oidc.domain,
    MCP_AUDIENCE: MCP_AUD,
    MCP_RESOURCE_CLIENT_ID: "mcp_resource",
    MCP_RESOURCE_CLIENT_SECRET: "mcp-resource-secret",
    AGENT_BY_CLIENT_JSON: JSON.stringify({
      [MCP_CLIENT]: "agent_returns",
      [MCP_CLIENT_SR]: "agent_returns_sr",
    }),
    TASK_AUTHORITY_AUDIENCE: AUTHORITY_AUD,
    AUTHORITY_API_CLIENT_ID: CLIENTS.api,
    AUTHORITY_API_CLIENT_SECRET: `${CLIENTS.api}-secret`,
    AUTHORITY_EXECUTOR_CLIENT_ID: CLIENTS.executor,
    AUTHORITY_EXECUTOR_CLIENT_SECRET: `${CLIENTS.executor}-secret`,
    AUTHORITY_AUDITOR_CLIENT_ID: CLIENTS.investigator,
    AUTHORITY_AUDITOR_CLIENT_SECRET: `${CLIENTS.investigator}-secret`,
    REVIEWER_CLIENT_ID: REVIEWER_SPA,
    WAREHOUSE_SIGNING_SECRET: WAREHOUSE_SECRET,
    DEMO_MODE: "1",
    OPERATOR_TOKEN,
    WORKER_INTERVAL_MS: "300",
    HOST: "127.0.0.1",
    PORT: String(port),
    ...extra,
  });
  const app = await spawnNode(
    "demo/refund-desk/src/server.ts",
    appEnvBase(appPort),
    appPort,
  );

  /** The OIDC authorization-code + PKCE flow, performed as a browser would, without a browser. */
  async function login(
    userKey: string,
    o: {
      client?: string;
      audience?: string;
      org?: string;
      details?: unknown[];
      mfa?: boolean;
      /** The second factor the provider records in amr, e.g. "webauthn-platform" for a passkey. */
      factor?: string;
    } = {},
  ) {
    const user = users.find((u) => u.key === userKey)!;
    const client = o.client ?? MCP_CLIENT;
    const redirect =
      client === REVIEWER_SPA
        ? `${appOrigin}/review.html`
        : "http://127.0.0.1:1/cb";
    const verifier = randomUUID() + randomUUID();
    const q = new URLSearchParams({
      client_id: client,
      redirect_uri: redirect,
      response_type: "code",
      state: "s",
      nonce: "n",
      audience: o.audience ?? MCP_AUD,
      organization: o.org ?? user.org,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      _user: userKey,
    });
    if (o.details) q.set("authorization_details", JSON.stringify(o.details));
    if (o.mfa !== false && o.details) q.set("_mfa", MFA_CODE);
    if (o.factor) q.set("_factor", o.factor);
    const authz = await fetch(`${oidc.issuer}authorize`, {
      method: "POST",
      redirect: "manual",
      body: q,
    });
    if (authz.status !== 302)
      throw new Error(`authorize refused: ${authz.status}`);
    const code = new URL(authz.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const tok = (await (
      await fetch(`${oidc.issuer}oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client,
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
        }),
      })
    ).json()) as { access_token: string };
    return tok.access_token;
  }

  async function m2mToken(clientId: string) {
    const r = (await (
      await fetch(`${oidc.issuer}oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: `${clientId}-secret`,
          audience: AUTHORITY_AUD,
        }),
      })
    ).json()) as { access_token: string };
    return r.access_token;
  }

  async function warehouse(
    url: string,
    orderId: string,
    paymentId: string,
    orgId: string = ORG.northstar,
  ) {
    const body = JSON.stringify({
      eventId: `evt_${randomUUID()}`,
      type: "return.received",
      orgId,
      orderId,
      paymentId,
      reference: "SYNTHETIC-RMA",
    });
    const sig = await signWarehouseBody(
      WAREHOUSE_SECRET,
      body,
      Math.floor(Date.now() / 1000),
    );
    return fetch(`${url}/api/warehouse/events`, {
      method: "POST",
      headers: { "x-warehouse-signature": sig },
      body,
    });
  }

  /** The reviewer's decision, posted to the SERVICE with their own bound, step-up token. */
  async function decide(
    userKey: string,
    approvalId: string,
    digest: string,
    decision: "approve" | "reject" = "approve",
    org?: string,
  ) {
    const token = await login(userKey, {
      client: REVIEWER_SPA,
      audience: AUTHORITY_AUD,
      org,
      details: [
        {
          type: "task_authority_approval",
          approval_id: approvalId,
          operation_digest: digest,
        },
      ],
    });
    const res = await fetch(
      `${serviceUrl}/v1/approval-requests/${approvalId}/decisions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision, operationDigest: digest }),
      },
    );
    return {
      status: res.status,
      json: (await res.json()) as Record<string, any>,
    };
  }

  async function until<T>(
    fn: () => Promise<T>,
    ok: (v: T) => boolean,
    ms = 30_000,
    every = 200,
  ) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (ok(v) || Date.now() > end) return v;
      await new Promise((r) => setTimeout(r, every));
    }
  }

  const stack = {
    oidc,
    fga: fgaAdmin,
    fgaBackend: process.env.OPENFGA_BIN ? "openfga" : "fake-http",
    serviceDb,
    appDb,
    appOrigin,
    serviceUrl,
    get service() {
      return service;
    },
    app,
    users,
    login,
    m2mToken,
    warehouse,
    decide,
    until,
    appEnv: appEnvBase,
    startApp: (port: number, extra: Record<string, string> = {}) =>
      spawnNode(
        "demo/refund-desk/src/server.ts",
        appEnvBase(port, extra),
        port,
      ),
    freePort,
    async restartService() {
      await service.kill();
      service = await spawnNode(
        "auth0/service/src/server.ts",
        serviceEnv,
        servicePort,
      );
      return service;
    },
    /** Authority-side read as the investigator service credential. */
    async authorityGet(path: string) {
      const r = await fetch(`${serviceUrl}${path}`, {
        headers: {
          authorization: `Bearer ${await m2mToken(CLIENTS.investigator)}`,
        },
      });
      return {
        status: r.status,
        json: (await r.json()) as Record<string, any>,
      };
    },
    async close() {
      await app.kill().catch(() => undefined);
      await service.kill().catch(() => undefined);
      await oidc.close();
      await ("close" in fgaServer
        ? (fgaServer as { close(): Promise<void> }).close()
        : Promise.resolve());
      await serviceDb.drop();
      await appDb.drop();
    },
  };
  return stack;
}
