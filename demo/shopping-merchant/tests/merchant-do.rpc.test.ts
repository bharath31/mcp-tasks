import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const here = dirname(fileURLToPath(import.meta.url));

let mf: Miniflare;

const PORTS_SNIPPET = `
import { registerMerchantLedgerPorts } from "./merchant-do.js";
import { createFixtureCustomerAccount, createFixtureApprovalVerifier, createFixtureOrderProvider } from "./fixtures.js";
registerMerchantLedgerPorts({
  customerAccount: createFixtureCustomerAccount(),
  verifyCustomerApproval: createFixtureApprovalVerifier(),
  orderProvider: createFixtureOrderProvider(),
});
`;

before(async () => {
  const bundle = await build({
    stdin: {
      contents: `${PORTS_SNIPPET}
import { CustomerMerchantLedger } from "./merchant-do.js";
export { CustomerMerchantLedger };
export default {
  async fetch(request, env) {
    const customerId = request.headers.get("x-nominee-customer-id");
    if (!customerId) return new Response(JSON.stringify({ error: "customer_binding_required" }), { status: 400 });
    const id = env.LEDGER.idFromName(customerId);
    return env.LEDGER.get(id).fetch(request);
  },
};`,
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
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "merchant",
          modules: true,
          script: bundle.outputFiles[0]!.text,
          compatibilityDate: "2026-10-09",
          durableObjects: {
            LEDGER: { className: "CustomerMerchantLedger", useSQLite: true },
          },
        },
      ],
    }),
  );
});

after(async () => {
  await mf?.dispose();
});

test("DO fetch rejects injectCustomerApproval; approval is host-mediated only", async () => {
  const response = await mf.dispatchFetch("http://ledger/", {
    method: "POST",
    headers: {
      "x-nominee-customer-id": "fixture-customer",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      op: "injectCustomerApproval",
      quoteId: "q",
      actor: { kind: "human", customerId: "fixture-customer", scopes: [] },
    }),
  });
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "customer_approval_host_only");
});