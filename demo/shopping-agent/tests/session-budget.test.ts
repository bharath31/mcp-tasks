import assert from "node:assert/strict";
import test from "node:test";
import { runShoppingAgent } from "../src/agent.js";
import { shoppingAgentConfig } from "../src/config.js";
import {
  boundBrowserClose,
  capWaitMs,
  createSessionBudget,
  raceWithSessionBudget,
  SessionBudgetExceededError,
} from "../src/session-budget.js";
import type { HostActionResult } from "../src/ports.js";
import type { HostAction } from "../src/actions.js";
import {
  fakeBrowserLauncher,
  FakeBrowserSession,
  scriptedModel,
} from "./fakes.js";

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

test("host action that never settles ends as budget_exhausted", async () => {
  const config = shoppingAgentConfig.parse({
    merchantOrigin: "https://shop.example.test",
    sessionTimeoutMs: 5_000,
    maxModelCalls: 2,
    maxHostSteps: 4,
  });
  const model = scriptedModel([
    {
      content: null,
      toolCalls: [{ id: "1", name: "view_catalog", arguments: "{}" }],
    },
    {
      content: "should not run",
      toolCalls: [],
    },
  ]);
  class HangActionBrowser extends FakeBrowserSession {
    override runHostAction(_action: HostAction): Promise<HostActionResult> {
      return new Promise(() => {});
    }
  }
  const t0 = Date.now();
  const result = await runShoppingAgent({
    config,
    request: { goal: "catalog" },
    model,
    launchBrowser: fakeBrowserLauncher((id) => new HangActionBrowser(id)),
    sessionId: "budget-hang-action",
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.modelCalls, 1);
  assert.equal(result.hostSteps, 1);
  assert.ok(Date.now() - t0 < 6500);
});

test("late host action result is not applied and model is not called again", async () => {
  const config = shoppingAgentConfig.parse({
    merchantOrigin: "https://shop.example.test",
    sessionTimeoutMs: 5_000,
    maxModelCalls: 4,
    maxHostSteps: 4,
  });
  let modelCalls = 0;
  const model = {
    async run() {
      modelCalls++;
      return {
        content: null,
        toolCalls: [{ id: "1", name: "view_catalog", arguments: "{}" }],
      };
    },
    parseOutput: (raw: unknown) =>
      raw as import("../src/ports.js").ParsedModelOutput,
  };
  class DelayedActionBrowser extends FakeBrowserSession {
    override async runHostAction(
      action: HostAction,
    ): Promise<HostActionResult> {
      await new Promise((r) => setTimeout(r, 8_000));
      return super.runHostAction(action);
    }
  }
  const hostOk: boolean[] = [];
  const result = await runShoppingAgent({
    config,
    request: { goal: "catalog" },
    model,
    launchBrowser: fakeBrowserLauncher((id) => new DelayedActionBrowser(id)),
    emit: (e) => {
      if (e.type === "host_action") hostOk.push(e.ok);
    },
    sessionId: "budget-late-action",
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(modelCalls, 1);
  assert.deepEqual(hostOk, []);
});

test("never-settling browser.close does not hang session teardown", async () => {
  const config = shoppingAgentConfig.parse({
    merchantOrigin: "https://shop.example.test",
    sessionTimeoutMs: 120_000,
    maxModelCalls: 2,
  });
  class HangCloseBrowser extends FakeBrowserSession {
    override close(): Promise<void> {
      return new Promise(() => {});
    }
  }
  const model = {
    async run() {
      return { content: "done", toolCalls: [] };
    },
    parseOutput: () => ({ content: "done", toolCalls: [] }),
  };
  const t0 = Date.now();
  const result = await runShoppingAgent({
    config,
    request: { goal: "quick" },
    model,
    launchBrowser: fakeBrowserLauncher((id) => new HangCloseBrowser(id)),
    sessionId: "budget-hang-close",
  });
  assert.equal(result.status, "completed");
  assert.ok(Date.now() - t0 < 6500);
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
      toolCalls: [
        { id: "1", name: "add_to_cart", arguments: '{"productId":"tray"}' },
      ],
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
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("late"), 500),
        ),
      ),
    SessionBudgetExceededError,
  );
});

test("boundBrowserClose stops waiting when close never settles", async () => {
  const budget = createSessionBudget(Date.now(), 120_000, Date.now);
  const t0 = Date.now();
  await boundBrowserClose(budget, () => new Promise<void>(() => {}), 50);
  assert.ok(Date.now() - t0 < 500);
});
