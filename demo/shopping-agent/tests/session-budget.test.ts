import assert from "node:assert/strict";
import test from "node:test";
import { runShoppingAgent } from "../src/agent.js";
import { shoppingAgentConfig } from "../src/config.js";
import {
  capWaitMs,
  createSessionBudget,
  SessionBudgetExceededError,
} from "../src/session-budget.js";
import type { HostActionResult } from "../src/ports.js";
import type { HostAction } from "../src/actions.js";
import { fakeBrowserLauncher, FakeBrowserSession, scriptedModel } from "./fakes.js";

test("capWaitMs respects remaining session budget", () => {
  let now = 1000;
  const budget = createSessionBudget(1000, 5000, () => now);
  assert.equal(capWaitMs(budget, 20_000), 5000);
  now = 6001;
  assert.throws(() => capWaitMs(budget, 100), SessionBudgetExceededError);
});

test("agent marks budget_exhausted when model call spans deadline", async () => {
  const config = shoppingAgentConfig.parse({
    merchantOrigin: "https://shop.example.test",
    sessionTimeoutMs: 5_000,
    maxModelCalls: 4,
  });
  let now = 1000;
  const model = {
    async run() {
      now = 7000;
      return { content: "done", toolCalls: [] };
    },
    parseOutput: () => ({ content: "late", toolCalls: [] }),
  };
  const result = await runShoppingAgent({
    config,
    request: { goal: "quick" },
    model,
    launchBrowser: fakeBrowserLauncher(),
    now: () => now,
    sessionId: "budget-1",
  });
  assert.equal(result.status, "budget_exhausted");
});

test("slow host step aborts with budget_exhausted (no dangling waits)", async () => {
  const config = shoppingAgentConfig.parse({
    merchantOrigin: "https://shop.example.test",
    sessionTimeoutMs: 5_000,
    maxModelCalls: 2,
    maxHostSteps: 4,
  });
  let now = 1000;
  const model = scriptedModel([
    {
      content: null,
      toolCalls: [
        { id: "1", name: "view_catalog", arguments: "{}" },
      ],
    },
  ]);
  class SlowBrowserSession extends FakeBrowserSession {
    override async runHostAction(
      _action: HostAction,
    ): Promise<HostActionResult> {
      now = 7000;
      throw new SessionBudgetExceededError();
    }
  }
  const result = await runShoppingAgent({
    config,
    request: { goal: "catalog" },
    model,
    launchBrowser: fakeBrowserLauncher((id) => new SlowBrowserSession(id)),
    now: () => now,
    sessionId: "budget-2",
  });
  assert.equal(result.status, "budget_exhausted");
});