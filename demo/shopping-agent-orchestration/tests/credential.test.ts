import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hashAgentRunCredential,
  mintAgentRunCredential,
} from "../src/credential.js";

test("credential hash changes when secret changes", async () => {
  const a = mintAgentRunCredential("cust-a");
  const b = { ...a, secret: `${a.secret}x` };
  const ha = await hashAgentRunCredential(a);
  const hb = await hashAgentRunCredential(b);
  assert.notEqual(ha, hb);
});

test("minted credential never embeds bearer-shaped material in id", () => {
  const cred = mintAgentRunCredential("cust-a");
  assert.doesNotMatch(cred.runId, /bearer/i);
  assert.ok(cred.secret.length >= 32);
});
