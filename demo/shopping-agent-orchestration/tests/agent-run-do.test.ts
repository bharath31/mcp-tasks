import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mintAgentRunCredential } from "../src/credential.js";
import {
  readRpcJson,
  startOrchestrationHarness,
  type OrchestrationHarness,
} from "./support/miniflare-harness.js";

async function readRpc(res: Response) {
  return readRpcJson<{
    ok: boolean;
    error?: string;
    run?: { id: string; ownerId: string; events: unknown[]; status: string; reply?: string | null };
  }>(res);
}

let harness: OrchestrationHarness;

before(async () => {
  harness = await startOrchestrationHarness();
});

after(async () => {
  await harness.mf.dispose();
});

test("owner-bound DO rejects cross-owner polling", async () => {
  const cred = mintAgentRunCredential("owner-a");
  const create = await readRpc(
    await harness.dispatchRpc("owner-a", {
      op: "createRun",
      runId: cred.runId,
      goal: "add tray",
      credential: cred,
    }),
  );
  assert.equal(create.ok, true);

  const cross = await readRpc(
    await harness.dispatchRpc("owner-b", {
      op: "getRun",
      runId: cred.runId,
    }),
  );
  assert.equal(cross.ok, false);
  assert.match(cross.error ?? "", /run_not_found|owner_binding/);
});

test("credential secret is never stored on run record", async () => {
  const cred = mintAgentRunCredential("owner-leak");
  await harness.dispatchRpc("owner-leak", {
    op: "createRun",
    runId: cred.runId,
    goal: "add tray",
    credential: cred,
  });
  const got = await readRpc(
    await harness.dispatchRpc("owner-leak", {
      op: "getRun",
      runId: cred.runId,
    }),
  );
  assert.equal(got.ok, true);
  const blob = JSON.stringify(got.run);
  assert.doesNotMatch(blob, new RegExp(cred.secret));
  assert.notEqual(got.run?.status, undefined);
  assert.ok(!("credentialDigest" in (got.run ?? {})));
});

test("verifyAndStart requires matching scoped credential", async () => {
  const cred = mintAgentRunCredential("owner-c");
  await harness.dispatchRpc("owner-c", {
    op: "createRun",
    runId: cred.runId,
    goal: "browse",
    credential: cred,
  });
  const bad = await readRpc(
    await harness.dispatchRpc("owner-c", {
      op: "verifyAndStart",
      runId: cred.runId,
      credential: { ...cred, secret: cred.secret.slice(0, -1) },
    }),
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /credential_invalid/);

  const good = await readRpc(
    await harness.dispatchRpc("owner-c", {
      op: "verifyAndStart",
      runId: cred.runId,
      credential: cred,
    }),
  );
  assert.equal(good.ok, true);
  assert.equal(good.run?.status, "running");
});

test("mutating RPCs without credential are rejected", async () => {
  const cred = mintAgentRunCredential("owner-auth");
  await harness.dispatchRpc("owner-auth", {
    op: "createRun",
    runId: cred.runId,
    goal: "browse",
    credential: cred,
  });
  await harness.dispatchRpc("owner-auth", {
    op: "verifyAndStart",
    runId: cred.runId,
    credential: cred,
  });

  const forged = await readRpc(
    await harness.dispatchRpc("owner-auth", {
      op: "finishRun",
      runId: cred.runId,
      status: "completed",
      reply: "hijacked",
      credential: { ...cred, secret: cred.secret.slice(0, -2) + "00" },
    }),
  );
  assert.equal(forged.ok, false);
  assert.match(forged.error ?? "", /credential_invalid/);
});

test("expired credential is rejected at start", async () => {
  const cred = mintAgentRunCredential("owner-exp");
  await harness.dispatchRpc("owner-exp", {
    op: "createRun",
    runId: cred.runId,
    goal: "browse",
    credential: cred,
  });
  const expiredCred = { ...cred, expiresAtMs: Date.now() - 1 };
  const start = await readRpc(
    await harness.dispatchRpc("owner-exp", {
      op: "verifyAndStart",
      runId: expiredCred.runId,
      credential: expiredCred,
    }),
  );
  assert.equal(start.ok, false);
  assert.match(start.error ?? "", /credential_expired/);
});

test("createRun rejects oversized goal", async () => {
  const cred = mintAgentRunCredential("owner-goal");
  const res = await readRpc(
    await harness.dispatchRpc("owner-goal", {
      op: "createRun",
      runId: cred.runId,
      goal: "x".repeat(2500),
      credential: cred,
    }),
  );
  assert.equal(res.ok, false);
});

test("cleanupStale marks stuck running as failed and blocks late writes", async () => {
  const cred = mintAgentRunCredential("owner-stale");
  await harness.dispatchRpc("owner-stale", {
    op: "createRun",
    runId: cred.runId,
    goal: "browse",
    credential: cred,
  });
  const startedAt = Date.now();
  await harness.dispatchRpc("owner-stale", {
    op: "verifyAndStart",
    runId: cred.runId,
    credential: cred,
  });

  await harness.dispatchRpc("owner-stale", {
    op: "cleanupStale",
    nowMs: startedAt + 60_000,
    maxAgeMs: 24 * 60 * 60 * 1000,
    maxRunningAgeMs: 1_000,
  });

  const got = await readRpc(
    await harness.dispatchRpc("owner-stale", {
      op: "getRun",
      runId: cred.runId,
    }),
  );
  assert.equal(got.ok, true);
  assert.equal(got.run?.status, "failed");

  const late = await readRpc(
    await harness.dispatchRpc("owner-stale", {
      op: "appendEvents",
      runId: cred.runId,
      credential: cred,
      events: [{ atMs: Date.now(), kind: "progress", message: "late" }],
    }),
  );
  assert.equal(late.ok, false);
  assert.match(late.error ?? "", /run_not_active/);
});