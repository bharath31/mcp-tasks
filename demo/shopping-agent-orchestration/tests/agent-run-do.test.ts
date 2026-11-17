import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { hashAgentRunCredential, mintAgentRunCredential } from "../src/credential.js";
import {
  readRpcJson,
  startOrchestrationHarness,
  type OrchestrationHarness,
} from "./support/miniflare-harness.js";

async function readRpc(res: Response) {
  return readRpcJson<{
    ok: boolean;
    error?: string;
    run?: { id: string; ownerId: string; events: unknown[]; status: string };
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
  const digest = await hashAgentRunCredential(cred);
  const create = await readRpc(
    await harness.dispatchRpc("owner-a", {
      op: "createRun",
      runId: cred.runId,
      goal: "add tray",
      credentialDigest: digest,
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
  const digest = await hashAgentRunCredential(cred);
  await harness.dispatchRpc("owner-leak", {
    op: "createRun",
    runId: cred.runId,
    goal: "add tray",
    credentialDigest: digest,
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
  const digest = await hashAgentRunCredential(cred);
  await harness.dispatchRpc("owner-c", {
    op: "createRun",
    runId: cred.runId,
    goal: "browse",
    credentialDigest: digest,
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