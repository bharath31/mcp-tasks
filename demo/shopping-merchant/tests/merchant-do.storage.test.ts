import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const here = dirname(fileURLToPath(import.meta.url));

let mf: Miniflare;
let harnessScript: string;

function harnessMiniflare(): Miniflare {
  return new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "harness",
          modules: true,
          script: harnessScript,
          compatibilityDate: "2026-10-09",
          durableObjects: {
            HARNESS: { className: "MerchantStorageHarness", useSQLite: true },
          },
        },
      ],
    }),
  );
}

before(async () => {
  const bundle = await build({
    entryPoints: [join(here, "fixtures/storage-harness-worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    target: "es2023",
  });
  harnessScript = bundle.outputFiles[0]!.text;
  mf = harnessMiniflare();
});

after(async () => {
  await mf?.dispose();
});

test("DO SqlStorage transactionSync claims checkout execution once under parallel RPC", async () => {
  const mfFresh = harnessMiniflare();
  const [a, b] = await Promise.all([
    mfFresh.dispatchFetch("http://test/?op=claim-once"),
    mfFresh.dispatchFetch("http://test/?op=claim-once"),
  ]);
  const outcomes = await Promise.all([a.json(), b.json()]);
  const claimed = outcomes.filter((o) => (o as { claimed: boolean }).claimed);
  assert.equal(claimed.length, 1);
  await mfFresh.dispose();
});

test("DO SqlStorage cursor.one maps absent row to null", async () => {
  const response = await mf.dispatchFetch("http://test/?op=cursor-absent");
  const body = (await response.json()) as { row: unknown };
  assert.equal(body.row, null);
});