import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  fakeBrowserLauncher,
  scriptedModel,
} from "../../shopping-agent/tests/fakes.js";
import { shoppingAgentConfig } from "@nominee/shopping-agent";
import {
  executeShoppingAgentRun,
  prepareShoppingAgentRun,
  getShoppingAgentRun,
} from "../src/orchestrator.js";
import { agentRunStub, readAgentRunJson } from "../src/rpc.js";
import {
  startOrchestrationHarness,
  type OrchestrationHarness,
} from "./support/miniflare-harness.js";

const MERCHANT = "https://stillroom.fixture.test";

let harness: OrchestrationHarness;

before(async () => {
  harness = await startOrchestrationHarness();
});

after(async () => {
  await harness.mf.dispose();
});

test("orchestrator runs shopping agent with injectable ports and persists redacted events", async () => {
  const env = harness.testEnv(MERCHANT);
  const ownerId = "orch-customer";
  const prepared = await prepareShoppingAgentRun(env, {
    ownerId,
    goal: "view catalog",
    parentInnerSid: "parent-sid",
  });
  const config = shoppingAgentConfig.parse({ merchantOrigin: MERCHANT });

  const run = await executeShoppingAgentRun({
    env,
    ownerId,
    credential: prepared.credential,
    goal: "view catalog",
    configPartial: config,
    ports: () => ({
      model: scriptedModel([
        {
          toolCalls: [
            {
              id: "1",
              name: "view_catalog",
              arguments: "{}",
            },
            {
              id: "2",
              name: "finish_session",
              arguments: '{"summary":"done"}',
            },
          ],
          content: null,
        },
      ]),
      launchBrowser: fakeBrowserLauncher(),
    }),
  });

  assert.equal(run.status, "stopped");
  assert.ok(run.events.length > 0);
  const blob = JSON.stringify(run);
  assert.doesNotMatch(blob, new RegExp(prepared.credential.secret));
  const polled = await getShoppingAgentRun(env, ownerId, run.id);
  assert.ok(polled);
  assert.equal(polled.id, run.id);
});

test("prepare + stub path matches direct RPC create", async () => {
  const env = harness.testEnv(MERCHANT);
  const ownerId = "orch-direct";
  const prepared = await prepareShoppingAgentRun(env, {
    ownerId,
    goal: "hello",
    parentInnerSid: "parent-sid",
  });
  const res = await agentRunStub(env, ownerId).fetch(
    "http://agent-runs/internal",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nominee-owner-id": ownerId,
      },
      body: JSON.stringify({ op: "getRun", runId: prepared.credential.runId }),
    },
  );
  const body = await readAgentRunJson(res);
  assert.equal(body.ok, true);
  assert.equal(body.run?.goal, "hello");
});
