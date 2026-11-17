import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TEST_CUSTOMER } from "../../../shopping-merchant/tests/support/identity-jwt.js";
import {
  ORIGIN,
  apiJson,
  startHarness,
  type Harness,
} from "./support/harness.js";

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.mf.dispose();
});

async function waitForRun(
  cookie: string,
  runId: string,
  timeoutMs = 15_000,
): Promise<{ status: string; events: { message: string }[] }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, body } = await apiJson<{
      status?: string;
      events?: { message: string }[];
    }>(harness.mf, `/api/agent/${encodeURIComponent(runId)}`, { cookie });
    if (status !== 200) throw new Error(`poll_failed:${status}`);
    if (body.status && body.status !== "pending" && body.status !== "running") {
      return {
        status: body.status,
        events: body.events ?? [],
      };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("agent_run_timeout");
}

test("authenticated agent start persists sanitized run events (orchestration-only ports)", async () => {
  const { cookie, csrf } = await harness.login();
  const start = await apiJson<{
    id?: string;
    status?: string;
    events?: unknown[];
  }>(harness.mf, "/api/agent/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({ goal: "Add a catchall tray to my cart" }),
  });
  assert.equal(start.status, 200);
  assert.ok(start.body.id);
  const finished = await waitForRun(cookie, start.body.id!);
  assert.match(finished.status, /completed|stopped|failed|budget_exhausted/);
  const blob = JSON.stringify(finished);
  assert.doesNotMatch(blob, /bearer/i);
  assert.doesNotMatch(blob, /nsh_agent_cap/i);
});

test("agent-browser capability merges with existing session cart", async () => {
  const { cookie, csrf } = await harness.login();
  const seed = await apiJson(harness.mf, "/api/cart/items", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-csrf": csrf,
    },
    cookie,
    body: JSON.stringify({ productId: "cup", quantity: 1 }),
  });
  assert.equal(seed.status, 200);
  const cap = await harness.mintAgentCap(TEST_CUSTOMER, csrf);
  const add = await apiJson(harness.mf, "/api/agent-browser/cart/items", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-nominee-agent-browser-csrf": cap.csrf,
    },
    cookie: cap.cookie,
    body: JSON.stringify({ productId: "tray", quantity: 1 }),
  });
  assert.equal(add.status, 200);
  const cart = await apiJson<{ cart?: { items?: { productId: string }[] } }>(
    harness.mf,
    "/api/cart",
    { cookie },
  );
  const ids = (cart.body.cart?.items ?? []).map((i) => i.productId);
  assert.ok(ids.includes("cup"));
  assert.ok(ids.includes("tray"));
});
