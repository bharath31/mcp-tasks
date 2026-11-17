import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const here = dirname(fileURLToPath(import.meta.url));

let harnessScript: string;

function cibaHarnessMiniflare(): Miniflare {
  return new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "ciba-harness",
          modules: true,
          script: harnessScript,
          compatibilityDate: "2026-10-09",
          durableObjects: {
            CIBA_HARNESS: {
              className: "CibaChallengeHarness",
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
    entryPoints: [join(here, "fixtures/ciba-challenge-harness-worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    target: "es2023",
  });
  harnessScript = bundle.outputFiles[0]!.text;
});

after(async () => {
  // each test disposes its own instance
});

test("DO SqlStorage: concurrent claimPoll yields one winner", async () => {
  const mf = cibaHarnessMiniflare();
  const nowMs = 1_700_000_000_000;
  await mf.dispatchFetch(`http://test/?op=seed-polling&nowMs=${nowMs}`);
  const [a, b] = await Promise.all([
    mf.dispatchFetch(`http://test/?op=claim-poll&nowMs=${nowMs}`),
    mf.dispatchFetch(`http://test/?op=claim-poll&nowMs=${nowMs}`),
  ]);
  const outcomes = await Promise.all([a.json(), b.json()]);
  const claimed = outcomes.filter(
    (o) => (o as { claimed: boolean }).claimed,
  ).length;
  assert.equal(claimed, 1);
  await mf.dispose();
});

test("DO SqlStorage: concurrent consumeApproved is single-use", async () => {
  const mf = cibaHarnessMiniflare();
  const nowMs = 1_700_000_000_000;
  await mf.dispatchFetch(`http://test/?op=seed-approved&nowMs=${nowMs}`);
  const [a, b] = await Promise.all([
    mf.dispatchFetch(`http://test/?op=consume&nowMs=${nowMs}`),
    mf.dispatchFetch(`http://test/?op=consume&nowMs=${nowMs}`),
  ]);
  const outcomes = await Promise.all([a.json(), b.json()]);
  const wins = outcomes.filter((o) => (o as { ok: boolean }).ok).length;
  assert.equal(wins, 1);
  await mf.dispose();
});

test("DO SqlStorage: polling row survives between RPCs on same DO", async () => {
  const mf = cibaHarnessMiniflare();
  const nowMs = 1_700_000_000_000;
  await mf.dispatchFetch(`http://test/?op=seed-polling&nowMs=${nowMs}`);
  const first = await mf.dispatchFetch(
    "http://test/?op=get-status&id=chal-poll",
  );
  assert.equal(((await first.json()) as { status: string }).status, "polling");
  const later = await mf.dispatchFetch(
    "http://test/?op=get-status&id=chal-poll",
  );
  assert.equal(((await later.json()) as { status: string }).status, "polling");
  await mf.dispose();
});

test("DO SqlStorage: approved row survives between RPCs on same DO", async () => {
  const mf = cibaHarnessMiniflare();
  const nowMs = 1_700_000_000_000;
  await mf.dispatchFetch(`http://test/?op=seed-approved&nowMs=${nowMs}`);
  const first = await mf.dispatchFetch(
    "http://test/?op=get-status&id=chal-poll",
  );
  assert.equal(((await first.json()) as { status: string }).status, "approved");
  const later = await mf.dispatchFetch(
    "http://test/?op=get-status&id=chal-poll",
  );
  assert.equal(((await later.json()) as { status: string }).status, "approved");
  await mf.dispose();
});
