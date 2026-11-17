import assert from "node:assert/strict";
import { test } from "node:test";
import { merchantLedgerPortsFromEnv } from "../src/port-env.js";

test("runtime ports stay fail-closed; fixture env flags cannot enable simulated approval", () => {
  assert.throws(
    () =>
      merchantLedgerPortsFromEnv({
        USE_FIXTURE_MERCHANT_PORTS: "1",
        MERCHANT_FIXTURE_AUTO_APPROVE: "1",
      }),
    /merchant_ports_unconfigured/,
  );
});