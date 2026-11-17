import assert from "node:assert/strict";
import { test } from "node:test";
import type { ShoppingAgentEvent } from "@nominee/shopping-agent";
import {
  assertPublicEventsSafe,
  shoppingEventToPublic,
} from "../src/run-events.js";

test("public events redact credential-like host_action errors", () => {
  const event: ShoppingAgentEvent = {
    type: "host_action",
    action: { kind: "view_catalog" },
    ok: false,
    error: "upstream bearer abc.def.ghi rejected",
  };
  const pub = shoppingEventToPublic(event, Date.now());
  assert.doesNotMatch(pub.message, /bearer/i);
  assertPublicEventsSafe([pub]);
});

test("assertPublicEventsSafe rejects leaked authorization headers", () => {
  assert.throws(
    () =>
      assertPublicEventsSafe([
        {
          atMs: 1,
          kind: "test",
          message: "Authorization: Bearer secret-token",
        },
      ]),
    /public_run_event_leak/,
  );
});