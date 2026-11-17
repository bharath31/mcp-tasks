import assert from "node:assert/strict";
import test from "node:test";
import { runShoppingAgent } from "../src/agent.js";
import { shoppingAgentConfig } from "../src/config.js";
import {
  capWaitMs,
  createSessionBudget,
  raceWithSessionBudget,
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

test("agent budget_exhausted when model.run never settles", async () => {
  const config = shoppingAgentConfig.parse({
    merchantOrigin: "https://shop.example.test",
    sessionTimeoutMs: 5_000,
    maxModelCalls: 4,
  });
  const model = {
    async run() {
      return new Promise(() => {});
    },
    parseOutput: () => ({
      content: null,
      toolCalls: [{ id: "1", name: "add_to_cart", arguments: '{"productId":"tray"}' }],
    }),
  };
  const t0 = Date.now();
  const result = await runShoppingAgent({
    config,
    request: { goal: "hang" },
    model,
    launchBrowser: fakeBrowserLauncher(),
    sessionId: "budget-hang",
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.hostSteps, 0);
  assert.ok(Date.now() - t0 < 6500);
});

test("slow browser launch is closed and never used after budget timeout", async () => {
  const config = shoppingAgentConfig.parse({
    merchantOrigin: "https://shop.example.test",
    sessionTimeoutMs: 5_000,
    maxModelCalls: 2,
  });
  let lateSession: FakeBrowserSession | undefined;
  const launcher = async ({
    sessionId,
  }: Parameters<ReturnType<typeof fakeBrowserLauncher>>[0]) => {
    await new Promise((r) => setTimeout(r, 5_500));
    lateSession = new FakeBrowserSession(sessionId);
    return lateSession;
  };
  const model = {
    async run() {
      return { content: "ok", toolCalls: [] };
    },
    parseOutput: () => ({ content: "ok", toolCalls: [] }),
  };
  const result = await runShoppingAgent({
    config,
    request: { goal: "launch" },
    model,
    launchBrowser: launcher,
    sessionId: "budget-launch",
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.modelCalls, 0);
  await new Promise((r) => setTimeout(r, 6_500));
  assert.ok(lateSession);
  assert.equal(lateSession!.closed, true);
  assert.equal(lateSession!.navigations.length, 0);
});

test("raceWithSessionBudget rejects when work exceeds remaining budget", async () => {
  const budget = createSessionBudget(Date.now(), 50, Date.now);
  await assert.rejects(
    () =>
      raceWithSessionBudget(
        budget,
        new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500)),
      ),
    SessionBudgetExceededError,
  );
});