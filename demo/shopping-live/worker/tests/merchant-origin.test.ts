import assert from "node:assert/strict";
import test from "node:test";
import { merchantOriginConfigured } from "../src/merchant-origin.js";

test("merchantOriginConfigured rejects placeholder workers.dev hostname", () => {
  assert.equal(
    merchantOriginConfigured("https://nominee-shopping-live.workers.dev"),
    false,
  );
});

test("merchantOriginConfigured accepts operator HTTPS origins", () => {
  assert.equal(
    merchantOriginConfigured(
      "https://nominee-shopping-live.account-subdomain.workers.dev",
    ),
    true,
  );
  assert.equal(
    merchantOriginConfigured("https://shopping.nominee.dev"),
    true,
  );
});