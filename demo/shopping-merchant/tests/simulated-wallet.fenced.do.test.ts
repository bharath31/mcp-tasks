/**
 * Fenced simulated wallet + ledger on real DO SqlStorage (Miniflare).
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const here = dirname(fileURLToPath(import.meta.url));
const CUSTOMER = "fixture-customer";

let mf: Miniflare;
let harnessScript: string;

function walletHarnessMiniflare(): Miniflare {
  return new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "wallet-harness",
          modules: true,
          script: harnessScript,
          compatibilityDate: "2026-10-09",
          durableObjects: {
            WALLET_HARNESS: {
              className: "SimulatedWalletStorageHarness",
              useSQLite: true,
            },
          },
        },
      ],
    }),
  );
}

async function ledgerRpc(mfInstance: Miniflare, body: Record<string, unknown>) {
  return mfInstance.dispatchFetch("http://wallet/?op=ledger-rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerId: CUSTOMER, fenced: true, ...body }),
  });
}

before(async () => {
  const bundle = await build({
    entryPoints: [join(here, "fixtures/simulated-wallet-harness-worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    target: "es2023",
  });
  harnessScript = bundle.outputFiles[0]!.text;
  mf = walletHarnessMiniflare();
});

after(async () => {
  await mf?.dispose();
});

test("DO fenced: abandon unlocks cart after provider absent", async () => {
  const fresh = walletHarnessMiniflare();
  const setup = await ledgerRpc(fresh, { op: "ledger-setup-checkout" });
  assert.equal(setup.status, 200);
  const { quoteId } = (await setup.json()) as { quoteId: string };

  const exec = await ledgerRpc(fresh, {
    op: "ledger-execute-with-fault",
    quoteId,
  });
  assert.equal(exec.status, 200);
  const execBody = (await exec.json()) as { result: { status: string } };
  assert.equal(execBody.result.status, "processing");

  const recon = await ledgerRpc(fresh, { op: "ledger-reconcile", quoteId });
  const reconBody = (await recon.json()) as {
    result: { status: string };
  };
  assert.equal(reconBody.result.status, "provider_confirmed_absent");

  const abandon = await ledgerRpc(fresh, { op: "ledger-abandon", quoteId });
  const abandonBody = (await abandon.json()) as {
    result: { status: string };
    walletPeek: null;
    balanceAfter: number;
    balanceBefore: number;
  };
  assert.equal(abandonBody.result.status, "abandoned");
  assert.equal(abandonBody.walletPeek, null);
  assert.equal(abandonBody.balanceAfter, abandonBody.balanceBefore);

  const latePlace = await ledgerRpc(fresh, {
    op: "ledger-fenced-place",
    quoteId,
  });
  const lateBody = (await latePlace.json()) as {
    placed: { id: string } | null;
    balanceAfter: number;
    balanceBefore: number;
  };
  assert.equal(lateBody.placed, null);
  assert.equal(lateBody.balanceAfter, lateBody.balanceBefore);
  await fresh.dispose();
});

async function provision(mfInstance: Miniflare, amountMinor: number) {
  const response = await mfInstance.dispatchFetch(
    "http://wallet/?op=provision",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: CUSTOMER, amountMinor }),
    },
  );
  assert.equal(response.status, 200);
}

test("DO fenced: race abandon vs fenced place", async () => {
  const fresh = walletHarnessMiniflare();
  const setup = await ledgerRpc(fresh, { op: "ledger-setup-checkout" });
  const { quoteId } = (await setup.json()) as { quoteId: string };
  const exec = await ledgerRpc(fresh, {
    op: "ledger-execute-with-fault",
    quoteId,
  });
  assert.equal(
    ((await exec.json()) as { result: { status: string } }).result.status,
    "processing",
  );
  await ledgerRpc(fresh, { op: "ledger-reconcile", quoteId });
  await provision(fresh, 10_000);

  const [abandonResp, placeResp] = await Promise.all([
    ledgerRpc(fresh, { op: "ledger-abandon", quoteId }),
    ledgerRpc(fresh, { op: "ledger-fenced-place", quoteId }),
  ]);
  const abandon = (await abandonResp.json()) as {
    result: { status: string };
    walletPeek: { orderId: string } | null;
  };
  const place = (await placeResp.json()) as {
    placed: { id: string } | null;
  };
  if (place.placed) {
    assert.notEqual(abandon.result.status, "abandoned");
    const recon = await ledgerRpc(fresh, { op: "ledger-reconcile", quoteId });
    const body = (await recon.json()) as { result: { status: string } };
    assert.equal(body.result.status, "completed");
  } else {
    assert.equal(abandon.result.status, "abandoned");
    assert.equal(abandon.walletPeek, null);
  }
  await fresh.dispose();
});

test("DO fenced: unknown reconcile absent alone does not abandon", async () => {
  const fresh = walletHarnessMiniflare();
  const setup = await ledgerRpc(fresh, {
    op: "ledger-setup-checkout",
    fenced: false,
    provisionMinor: 0,
  });
  const { quoteId } = (await setup.json()) as { quoteId: string };
  await ledgerRpc(fresh, {
    op: "ledger-execute-with-fault",
    quoteId,
    fenced: false,
  });
  const recon = await ledgerRpc(fresh, {
    op: "ledger-reconcile",
    quoteId,
    fenced: false,
  });
  const reconBody = (await recon.json()) as {
    result: { status: string };
  };
  assert.equal(reconBody.result.status, "provider_confirmed_absent");
  const abandon = await ledgerRpc(fresh, {
    op: "ledger-abandon",
    quoteId,
    fenced: false,
  });
  assert.notEqual(abandon.status, 200);
  await fresh.dispose();
});
