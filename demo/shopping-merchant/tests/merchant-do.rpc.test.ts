import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { MERCHANT_HOST_INTERNAL_SECRET_HEADER } from "../src/port-env.js";

const here = dirname(fileURLToPath(import.meta.url));
const CUSTOMER = "fixture-customer";
const HOST_SECRET = "test-host-internal-secret";

const agent = {
  kind: "agent",
  customerId: CUSTOMER,
  agentId: "agent-a",
  pairwiseUserId: "user-u",
  sessionId: "session-s",
  scopes: ["cart:write", "checkout:write", "addresses:read"],
};
const human = { kind: "human", customerId: CUSTOMER, scopes: [] as string[] };

type WorkerMode = "per-customer" | "singleton-do";

function workerEntry(mode: WorkerMode): string {
  const idRouting =
    mode === "singleton-do"
      ? `const id = env.LEDGER.idFromName("singleton-binding-test");`
      : `const id = env.LEDGER.idFromName(customerId);`;
  return `import { CustomerMerchantLedger } from "./merchant-do.js";
export { CustomerMerchantLedger };
export default {
  async fetch(request, env) {
    const customerId = request.headers.get("x-nominee-customer-id");
    if (!customerId) return new Response(JSON.stringify({ error: "customer_binding_required" }), { status: 400 });
    ${idRouting}
    return env.LEDGER.get(id).fetch(request);
  },
};`;
}

async function buildMerchantWorker(mode: WorkerMode): Promise<string> {
  const bundle = await build({
    stdin: {
      contents: workerEntry(mode),
      resolveDir: join(here, "../src"),
      sourcefile: "worker-entry.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    target: "es2023",
  });
  return bundle.outputFiles[0]!.text;
}

function merchantMiniflare(script: string, opts?: { omitHostSecret?: boolean }): Miniflare {
  const bindings: Record<string, string> = {
    USE_FIXTURE_MERCHANT_PORTS: "1",
    MERCHANT_FIXTURE_AUTO_APPROVE: "1",
  };
  if (!opts?.omitHostSecret) {
    bindings.MERCHANT_HOST_INTERNAL_SECRET = HOST_SECRET;
  }
  return new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "merchant",
          modules: true,
          script,
          compatibilityDate: "2026-10-09",
          bindings,
          durableObjects: {
            LEDGER: { className: "CustomerMerchantLedger", useSQLite: true },
          },
        },
      ],
    }),
  );
}

async function post(
  mf: Miniflare,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return mf.dispatchFetch("http://ledger/", {
    method: "POST",
    headers: {
      "x-nominee-customer-id": CUSTOMER,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

let scriptPerCustomer: string;
let scriptSingleton: string;

before(async () => {
  scriptPerCustomer = await buildMerchantWorker("per-customer");
  scriptSingleton = await buildMerchantWorker("singleton-do");
});

test("DO fetch rejects injectCustomerApproval; approval is host-mediated only", async () => {
  const mf = merchantMiniflare(scriptPerCustomer);
  try {
    const response = await post(mf, {
      op: "injectCustomerApproval",
      quoteId: "q",
      actor: human,
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "customer_approval_host_only");
  } finally {
    await mf.dispose();
  }
});

test("DO permanently binds customer id and rejects header mismatch", async () => {
  const mf = merchantMiniflare(scriptSingleton);
  try {
    const ok = await post(
      mf,
      { op: "createCart", actor: agent },
      { "x-nominee-customer-id": CUSTOMER },
    );
    assert.equal(ok.status, 200);
    const mismatch = await post(
      mf,
      { op: "createCart", actor: { ...agent, customerId: "other-customer" } },
      { "x-nominee-customer-id": "other-customer" },
    );
    assert.equal(mismatch.status, 403);
    const body = (await mismatch.json()) as { error: string };
    assert.equal(body.error, "customer_binding_mismatch");
  } finally {
    await mf.dispose();
  }
});

test("hostInjectCustomerApproval requires configured secret (fail-closed when unset)", async () => {
  const mf = merchantMiniflare(scriptPerCustomer, { omitHostSecret: true });
  try {
    const response = await post(
      mf,
      { op: "hostInjectCustomerApproval", quoteId: "q", actor: human },
      { [MERCHANT_HOST_INTERNAL_SECRET_HEADER]: "wrong" },
    );
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "customer_approval_host_unavailable");
  } finally {
    await mf.dispose();
  }
});

test("DO happy path: cart, quote, host approval transport, executeQuote", async () => {
  const mf = merchantMiniflare(scriptPerCustomer);
  try {
    const cartRes = await post(mf, { op: "createCart", actor: agent });
    assert.equal(cartRes.status, 200);
    const cart = (await cartRes.json()) as { id: string };

    const updateRes = await post(mf, {
      op: "updateCart",
      actor: agent,
      cartId: cart.id,
      items: [{ productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" }],
    });
    assert.equal(updateRes.status, 200);

    const quoteRes = await post(mf, {
      op: "createQuote",
      actor: agent,
      cartId: cart.id,
      shippingAddressId: "fixture-home",
    });
    assert.equal(quoteRes.status, 200);
    const quote = (await quoteRes.json()) as { id: string };

    const beforeExecute = await post(mf, {
      op: "executeQuote",
      actor: agent,
      quoteId: quote.id,
    });
    assert.equal(beforeExecute.status, 200);
    assert.deepEqual(await beforeExecute.json(), { status: "customer_verification_required" });

    const injectRes = await post(
      mf,
      { op: "hostInjectCustomerApproval", quoteId: quote.id, actor: human },
      { [MERCHANT_HOST_INTERNAL_SECRET_HEADER]: HOST_SECRET },
    );
    assert.equal(injectRes.status, 200);

    const executeRes = await post(mf, {
      op: "executeQuote",
      actor: agent,
      quoteId: quote.id,
    });
    assert.equal(executeRes.status, 200);
    const executed = (await executeRes.json()) as { status: string };
    assert.equal(executed.status, "completed");
  } finally {
    await mf.dispose();
  }
});
