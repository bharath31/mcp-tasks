import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const here = dirname(fileURLToPath(import.meta.url));

let harnessScript: string;

function mf(): Miniflare {
  return new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "ciba-ledger-harness",
          modules: true,
          script: harnessScript,
          compatibilityDate: "2026-10-09",
          durableObjects: {
            CIBA_LEDGER: {
              className: "CibaLedgerHarness",
              useSQLite: true,
            },
          },
        },
      ],
    }),
  );
}

before(async () => {
  const bundle = await build({
    entryPoints: [join(here, "fixtures/ciba-ledger-harness-worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers", "node:sqlite"],
    target: "es2023",
  });
  harnessScript = bundle.outputFiles[0]!.text;
});

test("DO SqlStorage: concurrent CIBA bridge records one approval and executes once", async () => {
  const miniflare = mf();
  const nowMs = 1_900_100_000_000;
  const seed = await miniflare.dispatchFetch(
    `http://test/?op=seed-quote&nowMs=${nowMs}`,
  );
  const { quoteId, challengeId } = (await seed.json()) as {
    quoteId: string;
    challengeId: string;
  };
  const [a, b] = await Promise.all([
    miniflare.dispatchFetch(
      `http://test/?op=bridge-once&nowMs=${nowMs}&quoteId=${encodeURIComponent(quoteId)}&challengeId=${encodeURIComponent(challengeId)}`,
    ),
    miniflare.dispatchFetch(
      `http://test/?op=bridge-once&nowMs=${nowMs}&quoteId=${encodeURIComponent(quoteId)}&challengeId=${encodeURIComponent(challengeId)}`,
    ),
  ]);
  const outcomes = await Promise.all([a.json(), b.json()]);
  const wins = outcomes.filter((o) => (o as { ok: boolean }).ok);
  assert.equal(wins.length, 1);
  const exec = await miniflare.dispatchFetch(
    `http://test/?op=execute&quoteId=${encodeURIComponent(quoteId)}`,
  );
  const result = (await exec.json()) as { status: string };
  assert.equal(result.status, "completed");
  await miniflare.dispose();
});