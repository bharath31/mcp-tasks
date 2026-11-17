import assert from "node:assert/strict";
import test from "node:test";
import { agentBrowserCsrfToken } from "../src/agent-capability.js";
import { mintAgentCapabilitySecret } from "../src/agent-capability.js";
import type { ShoppingLiveEnv } from "../src/env.js";

test("agent-browser CSRF token is HMAC and does not expose capability secret prefix", async () => {
  const env = {
    SHOPPING_SESSION_SECRET: "test-session-secret-32bytes-min",
  } as ShoppingLiveEnv;
  const runId = "run-test";
  const secret = mintAgentCapabilitySecret();
  const token = await agentBrowserCsrfToken(env, runId, secret);
  assert.ok(token.includes("."));
  assert.doesNotMatch(token, new RegExp(secret.slice(0, 16)));
  assert.doesNotMatch(token, new RegExp(secret.slice(0, 8)));
});