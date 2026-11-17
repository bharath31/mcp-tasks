import assert from "node:assert/strict";
import test from "node:test";
import { buildProductionWorkerBundle } from "./support/harness.js";

test("production Worker bundle excludes test-only session seeding", async () => {
  const { script, metafile } = await buildProductionWorkerBundle();
  assert.doesNotMatch(script, /seed-session/);
  assert.doesNotMatch(script, /mint-agent-cap/);
  assert.doesNotMatch(script, /revoke-agent-cap/);
  assert.doesNotMatch(script, /SHOPPING_TEST_HOOKS/);
  assert.doesNotMatch(script, /SHOPPING_LEDGER_TEST_HOOKS/);
  assert.doesNotMatch(script, /setQuoteExpiresAtForTest/);
  assert.doesNotMatch(script, /setCibaChallengeApprovedUnbridgedForTest/);
  assert.doesNotMatch(script, /harnessSetQuoteExpiresAt/);
  assert.doesNotMatch(script, /harnessSetCibaChallengeApprovedUnbridged/);
  assert.doesNotMatch(script, /identity-jwt/);

  const inputs = Object.keys(metafile.inputs);
  assert.ok(
    inputs.every(
      (path) =>
        !path.includes("/tests/") &&
        !path.includes("identity-jwt") &&
        !path.includes("seed-session"),
    ),
    `unexpected test paths in bundle: ${inputs.filter((p) => p.includes("/tests/")).join(", ")}`,
  );
});
