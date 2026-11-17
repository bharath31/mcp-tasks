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
import { sanitizePublicText } from "../src/sanitize.js";
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

test("executor failure always finishes run as failed", async () => {
  const env = harness.testEnv(MERCHANT);
  const ownerId = "orch-fail";
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
    ports: () => {
      throw new Error(`port factory bearer ${prepared.credential.secret}`);
    },
  });

  assert.equal(run.status, "failed");
  const polled = await getShoppingAgentRun(env, ownerId, run.id);
  assert.equal(polled?.status, "failed");
  const blob = JSON.stringify(polled);
  assert.doesNotMatch(blob, new RegExp(prepared.credential.secret));
});

test("reply sanitization removes known secret substrings", () => {
  const secret = "a".repeat(64);
  const raw = `model error bearer ${secret} tail`;
  const out = sanitizePublicText(raw, 4000, [secret]);
  assert.doesNotMatch(out, new RegExp(secret));
});

test("model error reply does not leak credential material", async () => {
  const env = harness.testEnv(MERCHANT);
  const ownerId = "orch-reply";
  const prepared = await prepareShoppingAgentRun(env, {
    ownerId,
    goal: "view catalog",
    parentInnerSid: "parent-sid",
  });
  const config = shoppingAgentConfig.parse({ merchantOrigin: MERCHANT });
  const secret = prepared.credential.secret;

  const run = await executeShoppingAgentRun({
    env,
    ownerId,
    credential: prepared.credential,
    goal: "view catalog",
    configPartial: config,
    ports: () => ({
      model: {
        async run() {
          throw new Error(`sensitive ${secret}`);
        },
        parseOutput: scriptedModel([]).parseOutput,
      },
      launchBrowser: fakeBrowserLauncher(),
    }),
  });

  assert.equal(run.status, "failed");
  const reply = run.reply ?? "";
  assert.doesNotMatch(reply, new RegExp(secret));
});
