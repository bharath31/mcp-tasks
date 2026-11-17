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

type WorkerMode = "per-customer" | "singleton-do" | "production-ports";

function workerEntry(mode: WorkerMode): string {
  const doImport =
    mode === "production-ports"
      ? `import { CustomerMerchantLedger } from "./src/merchant-do.js";
export { CustomerMerchantLedger };`
      : `import { RpcTestCustomerMerchantLedger as CustomerMerchantLedger } from "./tests/support/rpc-test-merchant-do.js";
export { CustomerMerchantLedger };`;
  const idRouting =
    mode === "singleton-do"
      ? `const id = env.LEDGER.idFromName("singleton-binding-test");`
      : `const id = env.LEDGER.idFromName(customerId);`;
  return `${doImport}
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
      resolveDir: join(here, ".."),
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

function merchantMiniflare(
  script: string,
  opts?: { omitHostSecret?: boolean; productionPorts?: boolean },
): Miniflare {
  const bindings: Record<string, string> = {};
  if (!opts?.productionPorts) {
    bindings.MERCHANT_HOST_INTERNAL_SECRET = opts?.omitHostSecret
      ? ""
      : HOST_SECRET;
  } else if (!opts?.omitHostSecret) {
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
      [MERCHANT_HOST_INTERNAL_SECRET_HEADER]: HOST_SECRET,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

let scriptPerCustomer: string;
let scriptSingleton: string;
let scriptProductionPorts: string;

before(async () => {
  scriptPerCustomer = await buildMerchantWorker("per-customer");
  scriptSingleton = await buildMerchantWorker("singleton-do");
  scriptProductionPorts = await buildMerchantWorker("production-ports");
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
      {
        "x-nominee-customer-id": "other-customer",
        [MERCHANT_HOST_INTERNAL_SECRET_HEADER]: HOST_SECRET,
      },
    );
    assert.equal(mismatch.status, 403);
    const body = (await mismatch.json()) as { error: string };
    assert.equal(body.error, "customer_binding_mismatch");
  } finally {
    await mf.dispose();
  }
});

test("DO RPC requires configured host secret (fail-closed when unset)", async () => {
  const mf = merchantMiniflare(scriptPerCustomer, { omitHostSecret: true });
  try {
    const response = await post(
      mf,
      { op: "createCart", actor: agent },
      { [MERCHANT_HOST_INTERNAL_SECRET_HEADER]: "wrong" },
    );
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "merchant_host_unavailable");
  } finally {
    await mf.dispose();
  }
});

test("DO RPC rejects wrong host secret when transport is configured", async () => {
  const mf = merchantMiniflare(scriptPerCustomer);
  try {
    const response = await post(
      mf,
      { op: "createCart", actor: agent },
      { [MERCHANT_HOST_INTERNAL_SECRET_HEADER]: "wrong-secret" },
    );
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "host_internal_forbidden");
  } finally {
    await mf.dispose();
  }
});

test("hostInjectCustomerApproval fails without fixture test proof (parity with ledger integration)", async () => {
  const mf = merchantMiniflare(scriptPerCustomer);
  try {
    const cartRes = await post(mf, { op: "createCart", actor: agent });
    const cart = (await cartRes.json()) as { id: string };
    await post(mf, {
      op: "updateCart",
      actor: agent,
      cartId: cart.id,
      items: [
        { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
      ],
    });
    const quoteRes = await post(mf, {
      op: "createQuote",
      actor: agent,
      cartId: cart.id,
      shippingAddressId: "fixture-home",
    });
    const quote = (await quoteRes.json()) as { id: string };
    const injectRes = await post(mf, {
      op: "hostInjectCustomerApproval",
      quoteId: quote.id,
      actor: human,
    });
    assert.equal(injectRes.status, 409);
    const err = (await injectRes.json()) as { error: string };
    assert.match(err.error, /customer_approval_unverified/);
  } finally {
    await mf.dispose();
  }
});

test("DO happy path: cart, quote, fixture proof + host approval transport, executeQuote", async () => {
  const mf = merchantMiniflare(scriptPerCustomer);
  try {
    const cartRes = await post(mf, { op: "createCart", actor: agent });
    assert.equal(cartRes.status, 200);
    const cart = (await cartRes.json()) as { id: string };

    const updateRes = await post(mf, {
      op: "updateCart",
      actor: agent,
      cartId: cart.id,
      items: [
        { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
      ],
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
    assert.deepEqual(await beforeExecute.json(), {
      status: "customer_verification_required",
    });

    const testProof = await post(mf, {
      op: "testFixtureApproveQuote",
      actor: agent,
      quoteId: quote.id,
    });
    assert.equal(testProof.status, 200);

    const injectRes = await post(mf, {
      op: "hostInjectCustomerApproval",
      quoteId: quote.id,
      actor: human,
    });
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

test("DO abandonQuote RPC is secret-gated and surfaces ledger abandon errors", async () => {
  const mf = merchantMiniflare(scriptPerCustomer);
  try {
    const cartRes = await post(mf, { op: "createCart", actor: agent });
    const cart = (await cartRes.json()) as { id: string };
    await post(mf, {
      op: "updateCart",
      actor: agent,
      cartId: cart.id,
      items: [
        { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
      ],
    });
    const quoteRes = await post(mf, {
      op: "createQuote",
      actor: agent,
      cartId: cart.id,
      shippingAddressId: "fixture-home",
    });
    assert.equal(quoteRes.status, 200);
    const quote = (await quoteRes.json()) as { id: string };
    const abandonRes = await post(mf, {
      op: "abandonQuote",
      actor: agent,
      quoteId: quote.id,
    });
    assert.equal(abandonRes.status, 409);
    const body = (await abandonRes.json()) as { error: string };
    assert.match(body.error, /checkout_not_started/);
  } finally {
    await mf.dispose();
  }
});

test("production DO ports stay unconfigured even with legacy fixture env keys", async () => {
  const mf = merchantMiniflare(scriptProductionPorts, {
    productionPorts: true,
  });
  try {
    const response = await mf.dispatchFetch("http://ledger/", {
      method: "POST",
      headers: {
        "x-nominee-customer-id": CUSTOMER,
        "content-type": "application/json",
        [MERCHANT_HOST_INTERNAL_SECRET_HEADER]: HOST_SECRET,
      },
      body: JSON.stringify({ op: "createCart", actor: agent }),
    });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /merchant_ports_unconfigured/);
  } finally {
    await mf.dispose();
  }
});
