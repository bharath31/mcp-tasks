import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { ORIGIN, apiJson, startHarness } from "./support/harness.js";

const here = dirname(fileURLToPath(import.meta.url));

test("deployable merchant DO bundle excludes harness ledger mutations", async () => {
  const merchantRoot = join(here, "../../../shopping-merchant");
  const bundle = await build({
    entryPoints: [join(merchantRoot, "src/merchant-do.ts")],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    target: "es2023",
  });
  const script = bundle.outputFiles[0]!.text;
  assert.doesNotMatch(script, /SHOPPING_LEDGER_TEST_HOOKS/);
  assert.doesNotMatch(script, /setQuoteExpiresAtForTest/);
  assert.doesNotMatch(script, /setCibaChallengeApprovedUnbridgedForTest/);
  assert.doesNotMatch(script, /harnessSetQuoteExpiresAt/);
  assert.doesNotMatch(script, /harnessSetCibaChallengeApprovedUnbridged/);
  const inputs = Object.keys(bundle.metafile!.inputs);
  assert.ok(
    inputs.every((path) => !path.includes("/tests/")),
    `unexpected test imports: ${inputs.filter((p) => p.includes("/tests/")).join(", ")}`,
  );
});

test("strict production merchant DO rejects legacy and harness mutation ops even with env hook flag", async () => {
  const harness = await startHarness({
    merchantDo: "production-strict",
    workerEntry: "test-worker-entry.ts",
    bindings: { SHOPPING_LEDGER_TEST_HOOKS: "1" },
  });
  try {
    const probe = await apiJson<{
      results?: { op: string; status: number; error?: string }[];
    }>(harness.mf, "/test/probe-forbidden-ledger-ops", { method: "POST" });
    assert.equal(probe.status, 200);
    assert.ok(probe.body.results?.length === 4);
    for (const row of probe.body.results ?? []) {
      assert.equal(
        row.status,
        400,
        `${row.op} should be unknown on production DO`,
      );
      assert.equal(row.error, "unknown_op", `${row.op} error body`);
    }
  } finally {
    await harness.mf.dispose();
  }
});
