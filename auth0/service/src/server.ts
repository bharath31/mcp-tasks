// Node entrypoint. The handler in http.ts is a plain Web-standard
// (Request) => Response function, so the same code can be hosted by a
// different runtime; this adapter is only for the reference deployment.
import { createServer } from "node:http";
import { createRemoteJWKSet } from "jose";
import {
  DEMO_DEFAULTS,
  DEMO_QUOTAS,
  type ServiceConfig,
  type TenantConfig,
} from "./config.js";
import { OpenFgaHttp } from "./fga.js";
import { createHandler } from "./http.js";
import { Store } from "./store.js";

type TenantEnv = {
  tenantId: string;
  issuer: string;
  audience: string;
  fga: { apiUrl: string; storeId: string; modelId?: string; token?: string };
  actions: TenantConfig["actions"];
  quotas?: Partial<TenantConfig["quotas"]>;
  defaults?: Partial<TenantConfig["defaults"]>;
  claimNamespace?: string;
  ciba?: {
    bcAuthorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    rar?: boolean;
  };
};

function tenantFromEnv(t: TenantEnv): TenantConfig {
  const issuer = t.issuer.replace(/\/?$/, "/");
  return {
    tenantId: t.tenantId,
    issuer,
    audience: t.audience,
    keys: createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`)),
    fga: new OpenFgaHttp({
      apiUrl: t.fga.apiUrl,
      storeId: t.fga.storeId,
      modelId: t.fga.modelId,
      getToken: t.fga.token ? async () => t.fga.token! : undefined,
    }),
    claimNamespace: t.claimNamespace,
    defaults: { ...DEMO_DEFAULTS, ...t.defaults },
    quotas: { ...DEMO_QUOTAS, ...t.quotas },
    actions: t.actions,
    ciba: t.ciba ? { ...t.ciba, audience: t.audience, issuer } : undefined,
  };
}

/**
 * Configuration from the environment. Either one tenant from the AUTH0_ and FGA_ variables, or
 * several from TENANTS_JSON (an array of per-tenant issuer, audience, FGA, actions, quotas, ciba).
 */
export function configFromEnv(env: NodeJS.ProcessEnv): ServiceConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing required environment variable ${k}`);
    return v;
  };
  const tenants: TenantEnv[] = env.TENANTS_JSON
    ? (JSON.parse(env.TENANTS_JSON) as TenantEnv[])
    : [
        {
          tenantId: need("TENANT_ID"),
          issuer: need("AUTH0_ISSUER"),
          audience: need("AUTH0_AUDIENCE"),
          fga: {
            apiUrl: need("FGA_API_URL"),
            storeId: need("FGA_STORE_ID"),
            modelId: env.FGA_MODEL_ID,
            token: env.FGA_API_TOKEN,
          },
          actions: JSON.parse(need("TENANT_ACTIONS_JSON")),
          claimNamespace: env.CLAIM_NAMESPACE,
          ciba: env.CIBA_TOKEN_URL
            ? {
                bcAuthorizeUrl: need("CIBA_BC_AUTHORIZE_URL"),
                tokenUrl: env.CIBA_TOKEN_URL,
                clientId: need("CIBA_CLIENT_ID"),
                clientSecret: need("CIBA_CLIENT_SECRET"),
                rar: env.CIBA_RAR !== "0",
              }
            : undefined,
        },
      ];
  if (new Set(tenants.map((t) => t.tenantId)).size !== tenants.length)
    throw new Error("Duplicate tenantId");
  if (new Set(tenants.map((t) => t.issuer)).size !== tenants.length)
    throw new Error("Each tenant needs a distinct issuer");
  return {
    clockSkewSec: 30,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
    tenants: tenants.map(tenantFromEnv),
  };
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

const MAX_REQUEST_BYTES = 128 * 1024;

/** Hosts a Web-standard handler on node:http. Returns the listening server. */
export function listen(
  handle: (r: Request) => Promise<Response>,
  port: number,
  host = "127.0.0.1",
) {
  const server = createServer(async (req, res) => {
    const body = await readLimited(req, MAX_REQUEST_BYTES);
    if (body === null) {
      res.writeHead(413, {
        "content-type": "application/json",
        connection: "close",
      });
      return void res.end(
        JSON.stringify({
          code: "invalid_request",
          message: "Request body too large.",
          correlationId: "n/a",
          retryable: false,
        }),
      );
    }
    const r = await handle(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: ["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET")
          ? undefined
          : body,
      }),
    );
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  return new Promise<import("node:http").Server>((resolve) =>
    server.listen(port, host, () => resolve(server)),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const store = new Store(
    process.env.TASK_AUTHORITY_DATABASE_URL ??
      (() => {
        throw new Error("TASK_AUTHORITY_DATABASE_URL required");
      })(),
  );
  if (process.env.MIGRATE_ON_START === "1") await store.migrate();
  const handle = createHandler({ store, config: configFromEnv(process.env) });
  const port = Number(process.env.PORT ?? 8788);
  await listen(handle, port, process.env.HOST ?? "0.0.0.0");
  console.log(JSON.stringify({ event: "listening", port }));
}
