import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  shoppingTestJwks,
  TEST_AUDIENCE,
  TEST_CUSTOMER,
  TEST_DOMAIN,
} from "../../../../shopping-merchant/tests/support/identity-jwt.js";
import type { JWTVerifyGetKey } from "jose";

const here = dirname(fileURLToPath(import.meta.url));
const puppeteerStubPath = join(here, "puppeteer-stub.ts");

function puppeteerStubPlugin(): import("esbuild").Plugin {
  return {
    name: "puppeteer-stub",
    setup(build: import("esbuild").PluginBuild) {
      build.onResolve({ filter: /^@cloudflare\/puppeteer$/ }, () => ({
        path: puppeteerStubPath,
      }));
    },
  };
}
export const HOST_SECRET = "test-host-internal-secret";
export const SESSION_SECRET = "test-session-secret-32bytes-min";
export const ORIGIN = "http://localhost:8787";
export const MERCHANT_ORIGIN = "https://localhost:8787";

export async function buildShoppingWorker(options?: {
  merchantDo?: "fixture" | "production";
}): Promise<string> {
  const merchantShim =
    options?.merchantDo === "production"
      ? join(here, "merchant-do-production-shim.ts")
      : join(here, "merchant-do-shim.ts");
  const plugins: import("esbuild").Plugin[] = [puppeteerStubPlugin()];
  if (options?.merchantDo === "production") {
    plugins.push({
      name: "merchant-do-shim",
      setup(build: import("esbuild").PluginBuild) {
        build.onResolve({ filter: /merchant-do-shim\.js$/ }, () => ({
          path: merchantShim,
        }));
      },
    });
  }
  const bundle = await build({
    entryPoints: [join(here, "test-worker-entry.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    target: "es2023",
    plugins,
  });
  return bundle.outputFiles[0]!.text;
}

export async function buildProductionWorkerBundle(): Promise<{
  script: string;
  metafile: import("esbuild").Metafile;
}> {
  const workerRoot = join(here, "../..");
  const bundle = await build({
    entryPoints: [join(workerRoot, "src/worker.ts")],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    target: "es2023",
    plugins: [puppeteerStubPlugin()],
  });
  return {
    script: bundle.outputFiles[0]!.text,
    metafile: bundle.metafile!,
  };
}

export type DispatchResponse = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;

export type OutboundHandler = (
  request: Request,
  miniflare: Miniflare,
) => Promise<Response>;

export type Harness = {
  mf: Miniflare;
  jwks: JWTVerifyGetKey;
  login: (customerId?: string) => Promise<{ cookie: string; csrf: string }>;
  mintAgentCap: (
    customerId: string,
    innerSid: string,
  ) => Promise<{ cookie: string; csrf: string; runId: string }>;
};

export async function startHarness(options?: {
  outbound?: OutboundHandler;
  merchantDo?: "fixture" | "production";
  bindings?: Record<string, string>;
}): Promise<Harness> {
  const script = await buildShoppingWorker({
    merchantDo: options?.merchantDo,
  });
  const jwks = await shoppingTestJwks();
  const worker: Record<string, unknown> = {
    name: "shopping-live",
    modules: true,
    script,
    compatibilityDate: "2026-10-09",
    bindings: {
      MERCHANT_HOST_INTERNAL_SECRET: HOST_SECRET,
      SHOPPING_AUTH0_DOMAIN: TEST_DOMAIN,
      SHOPPING_API_AUDIENCE: TEST_AUDIENCE,
      SHOPPING_AUTH0_CLIENT_ID: "test-client",
      SHOPPING_AUTH0_CLIENT_SECRET: "test-secret",
      SHOPPING_SESSION_SECRET: SESSION_SECRET,
      SHOPPING_PUBLIC_ORIGIN: ORIGIN,
      SHOPPING_MERCHANT_SHIPPING_ADDRESS_ID: "merchant-default",
      SHOPPING_BROWSER_AGENT_ID: "browser-shopping",
      SHOPPING_MERCHANT_WALLET_MODE: "simulated",
      SHOPPING_MERCHANT_WALLET_LABEL: "Stillroom wallet",
      SHOPPING_MERCHANT_DISPLAY_NAME: "Stillroom",
      MERCHANT_ORIGIN,
      SHOPPING_AGENT_AWAIT_RUN: "1",
      AI: {},
      BROWSER: {},
      ...options?.bindings,
    },
    durableObjects: {
      CUSTOMER_STATE: { className: "CustomerHostState", useSQLite: true },
      MERCHANT_LEDGER: {
        className: "CustomerMerchantLedger",
        useSQLite: true,
      },
      AGENT_RUNS: { className: "ShoppingAgentRunState", useSQLite: true },
    },
  };
  const runtime: { mf: Miniflare | null } = { mf: null };
  if (options?.outbound && options.merchantDo === "production") {
    worker.serviceBindings = {
      SUBREQUEST_FETCH: (request: Request) =>
        options.outbound!(request, runtime.mf!),
    };
  }
  const mfOptions = convertV4MiniflareOptions({
    workers: [worker],
  } as Parameters<typeof convertV4MiniflareOptions>[0]);
  if (options?.outbound) {
    const first = mfOptions.workers[0]!;
    first.dev = {
      ...first.dev,
      outboundService: {
        type: "fetcher",
        handler: options.outbound as never,
      },
    };
  }
  const mf = new Miniflare(mfOptions);
  runtime.mf = mf;

  async function login(
    customerId = TEST_CUSTOMER,
  ): Promise<{ cookie: string; csrf: string }> {
    const res = await mf.dispatchFetch(`${ORIGIN}/test/seed-session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ customerId }),
    });
    assertOk(res);
    const body = (await res.json()) as { cookie?: string; csrfToken?: string };
    if (!body.cookie || !body.csrfToken) throw new Error("seed_failed");
    return { cookie: body.cookie, csrf: body.csrfToken };
  }

  async function mintAgentCap(
    customerId: string,
    innerSid: string,
  ): Promise<{ cookie: string; csrf: string; runId: string }> {
    const res = await mf.dispatchFetch(`${ORIGIN}/test/mint-agent-cap`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ customerId, innerSid }),
    });
    assertOk(res);
    const body = (await res.json()) as {
      cookie?: string;
      csrfToken?: string;
      runId?: string;
    };
    if (!body.cookie || !body.csrfToken || !body.runId) {
      throw new Error("mint_agent_cap_failed");
    }
    return { cookie: body.cookie, csrf: body.csrfToken, runId: body.runId };
  }

  return { mf, jwks, login, mintAgentCap };
}

export function assertOk(res: DispatchResponse): void {
  if (!res.ok) {
    throw new Error(`unexpected status ${res.status}: ${res.statusText}`);
  }
}

export async function apiJson<T>(
  mf: Miniflare,
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const fetchInit: RequestInit = {
    method: init.method,
    redirect: init.redirect,
    headers: Object.fromEntries(headers.entries()),
  };
  if (init.body != null) fetchInit.body = init.body;
  const res = await mf.dispatchFetch(
    `${ORIGIN}${path}`,
    fetchInit as Parameters<Miniflare["dispatchFetch"]>[1],
  );
  let body: T;
  try {
    body = (await res.json()) as T;
  } catch {
    body = {} as T;
  }
  return { status: res.status, body };
}
