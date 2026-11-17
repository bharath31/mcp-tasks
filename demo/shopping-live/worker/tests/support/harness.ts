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
export const HOST_SECRET = "test-host-internal-secret";
export const SESSION_SECRET = "test-session-secret-32bytes-min";
export const ORIGIN = "http://localhost:8787";

export async function buildShoppingWorker(): Promise<string> {
  const bundle = await build({
    entryPoints: [join(here, "test-worker-entry.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    target: "es2023",
    plugins: [
      {
        name: "fixture-merchant-do",
        setup(build) {
          build.onResolve({ filter: /merchant-do-binding\.js$/ }, () => ({
            path: join(here, "merchant-do-shim.ts"),
          }));
        },
      },
    ],
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
};

export async function startHarness(options?: {
  outbound?: OutboundHandler;
}): Promise<Harness> {
  const script = await buildShoppingWorker();
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
    },
    durableObjects: {
      CUSTOMER_STATE: { className: "CustomerHostState", useSQLite: true },
      MERCHANT_LEDGER: {
        className: "CustomerMerchantLedger",
        useSQLite: true,
      },
    },
  };
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

  return { mf, jwks, login };
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
