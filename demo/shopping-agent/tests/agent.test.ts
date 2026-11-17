import assert from "node:assert/strict";
import test from "node:test";
import { runShoppingAgent } from "../src/agent.js";
import { shoppingAgentConfig } from "../src/config.js";
import { fakeBrowserLauncher, FakeBrowserSession, scriptedModel } from "./fakes.js";

const config = shoppingAgentConfig.parse({
  merchantOrigin: "https://shop.example.test",
  productIds: ["tray", "cup"],
  maxModelCalls: 4,
  maxHostSteps: 8,
});

test("agent runs model tools through host validation without checkout", async () => {
  const browserRef: { current?: FakeBrowserSession } = {};
  const events: string[] = [];
  const model = scriptedModel(
    [
      {
        content: null,
        toolCalls: [
          {
            id: "1",
            name: "navigate_shop",
            arguments: JSON.stringify({ path: "/", hash: "#shop" }),
          },
        ],
      },
      {
        content: null,
        toolCalls: [
          { id: "2", name: "add_to_cart", arguments: JSON.stringify({ productId: "tray" }) },
        ],
      },
      {
        content: null,
        toolCalls: [
          {
            id: "3",
            name: "finish_session",
            arguments: JSON.stringify({ summary: "Added tray to cart; stopped before checkout." }),
          },
        ],
      },
    ],
  );

  const result = await runShoppingAgent({
    config,
    request: { goal: "Add a catchall tray to my cart." },
    model,
    launchBrowser: fakeBrowserLauncher((id) => {
      const s = new FakeBrowserSession(id);
      browserRef.current = s;
      return s;
    }),
    emit: (e) => events.push(e.type),
    sessionId: "sess-test-1",
  });

  assert.equal(result.status, "stopped");
  assert.match(result.reply ?? "", /checkout/i);
  assert.equal(result.modelCalls, 3);
  assert.ok(browserRef.current?.closed);
  assert.deepEqual(browserRef.current?.clicks, ["tray"]);
  assert.equal(browserRef.current?.cartItems[0]?.quantity, 1);
  assert.ok(events.includes("session_end"));
});

test("rejects escape hatch tool invocation from model", async () => {
  const model = scriptedModel([
    {
      content: null,
      toolCalls: [{ id: "x", name: "run_javascript", arguments: "{}" }],
    },
    { content: "I cannot do that.", toolCalls: [] },
  ]);
  const result = await runShoppingAgent({
    config,
    request: { goal: "Run JS in the page" },
    model,
    launchBrowser: fakeBrowserLauncher(),
    sessionId: "sess-test-2",
  });
  assert.notEqual(result.status, "error");
  assert.ok(result.modelCalls >= 1);
});

test("checkout boundary surfaces when host refuses add", async () => {
  const model = scriptedModel([
    {
      content: null,
      toolCalls: [
        { id: "1", name: "add_to_cart", arguments: JSON.stringify({ productId: "cup" }) },
        {
          id: "2",
          name: "finish_session",
          arguments: JSON.stringify({ summary: "Stopped at boundary." }),
        },
      ],
    },
  ]);
  const result = await runShoppingAgent({
    config,
    request: { goal: "add cup" },
    model,
    launchBrowser: fakeBrowserLauncher((id) => {
      const s = new FakeBrowserSession(id);
      s.rejectNextAdd = true;
      return s;
    }),
    emit: (e) => {
      if (e.type === "checkout_boundary") assert.match(e.detail, /checkout/i);
    },
    sessionId: "sess-test-3",
  });
  assert.equal(result.status, "stopped");
});