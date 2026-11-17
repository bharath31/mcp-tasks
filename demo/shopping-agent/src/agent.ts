import { z } from "zod";
import {
  AGENT_TOOLS,
  PERMITTED_TOOL_NAMES,
  actionFromToolCall,
  type HostAction,
} from "./actions.js";
import {
  shoppingAgentConfig,
  type ShoppingAgentConfig,
} from "./config.js";
import { merchantHostname } from "./config.js";
import { executeHostAction } from "./executor.js";
import { REQUEST_INTERCEPTION_LIMITS } from "./guard.js";
import type {
  BrowserLauncher,
  BrowserSessionPort,
  ModelMessage,
  ModelPort,
} from "./ports.js";
import { safeEvent, type ShoppingAgentEvent } from "./events.js";
import { redactText } from "./redact.js";
import {
  assertWithinBudget,
  discardLateBrowserSession,
  discardLateModelRun,
  raceWithSessionBudget,
  SessionBudgetExceededError,
  type SessionBudget,
} from "./session-budget.js";

export const shoppingRequest = z
  .object({
    goal: z.string().trim().min(1).max(2000),
  })
  .strict();

export type ShoppingRequest = z.infer<typeof shoppingRequest>;

export type ShoppingAgentResult = {
  status: "completed" | "stopped" | "budget_exhausted" | "error";
  reply: string | null;
  hostSteps: number;
  modelCalls: number;
  sessionId: string;
  limits: string;
};

const SYSTEM = (config: ShoppingAgentConfig) =>
  `You are a bounded shopping assistant for a single trusted merchant (${merchantHostname(config)}). You may only use the tools provided. Add catalog items the user asks for, inspect the cart, then call finish_session. Never attempt checkout, payment, quote review, address entry, or credential entry. Never invent product ids. Prices shown in the catalog are informational only; you cannot authorize purchases. ${REQUEST_INTERCEPTION_LIMITS}`;

function clipToolResult(value: unknown, max = 6000): string {
  return redactText(JSON.stringify(value), max);
}

export async function runShoppingAgent(opts: {
  config: ShoppingAgentConfig;
  request: ShoppingRequest;
  model: ModelPort;
  launchBrowser: BrowserLauncher;
  emit?: (e: ShoppingAgentEvent) => void;
  now?: () => number;
  sessionId?: string;
}): Promise<ShoppingAgentResult> {
  const config = shoppingAgentConfig.parse(opts.config);
  const request = shoppingRequest.parse(opts.request);
  const emit = (e: ShoppingAgentEvent) => opts.emit?.(safeEvent(e));
  const now = opts.now ?? Date.now;
  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const started = now();
  const deadline = started + config.sessionTimeoutMs;
  const budget: SessionBudget = { deadlineMs: deadline, now };

  let browser: BrowserSessionPort | undefined;
  let hostSteps = 0;
  let modelCalls = 0;
  let reply: string | null = null;
  let status: ShoppingAgentResult["status"] = "stopped";

  emit({
    type: "session_start",
    sessionId,
    merchant: merchantHostname(config),
  });

  try {
    const launchWork = opts.launchBrowser({
      sessionId,
      merchantHostname: merchantHostname(config),
      allowedDomains: [merchantHostname(config)],
      sessionDeadlineMs: deadline,
    });
    try {
      browser = await raceWithSessionBudget(budget, launchWork);
    } catch (e) {
      if (e instanceof SessionBudgetExceededError) {
        discardLateBrowserSession(launchWork);
      }
      throw e;
    }

    const messages: ModelMessage[] = [
      { role: "user", content: request.goal },
    ];

    for (let i = 0; i < config.maxModelCalls; i++) {
      if (now() > deadline) {
        emit({ type: "budget_exhausted", kind: "timeout" });
        status = "budget_exhausted";
        break;
      }

      emit({ type: "model_start", n: i + 1 });
      assertWithinBudget(budget);
      const modelWork = opts.model.run(config.model, {
        messages: [{ role: "system", content: SYSTEM(config) }, ...messages],
        tools: [...AGENT_TOOLS],
        temperature: config.temperature,
        max_completion_tokens: 1200,
      });
      let raw: unknown;
      try {
        raw = await raceWithSessionBudget(budget, modelWork);
      } catch (e) {
        if (e instanceof SessionBudgetExceededError) {
          discardLateModelRun(modelWork);
        }
        throw e;
      }
      if (now() > deadline) {
        emit({ type: "budget_exhausted", kind: "timeout" });
        status = "budget_exhausted";
        break;
      }
      modelCalls++;
      const { content, toolCalls } = opts.model.parseOutput(raw);
      emit({
        type: "model_done",
        n: i + 1,
        toolNames: toolCalls.map((t) => t.name),
      });

      messages.push({
        role: "assistant",
        content,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      });

      if (!toolCalls.length) {
        reply = content;
        status = "completed";
        break;
      }

      let stopAction: HostAction | null = null;

      for (const call of toolCalls) {
        if (!PERMITTED_TOOL_NAMES.has(call.name)) {
          const err = `tool not permitted: ${call.name}`;
          emit({
            type: "host_action",
            action: { kind: "stop", summary: "denied" },
            ok: false,
            error: err,
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: clipToolResult({ ok: false, error: err }),
          });
          continue;
        }

        let action: HostAction;
        try {
          action = actionFromToolCall(call.name, call.arguments);
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          emit({
            type: "host_action",
            action: { kind: "stop", summary: "invalid" },
            ok: false,
            error: err,
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: clipToolResult({ ok: false, error: err }),
          });
          continue;
        }

        if (action.kind === "stop") {
          stopAction = action;
        }

        hostSteps++;
        if (hostSteps > config.maxHostSteps) {
          emit({ type: "budget_exhausted", kind: "steps" });
          status = "budget_exhausted";
          break;
        }

        if (now() > deadline) {
          emit({ type: "budget_exhausted", kind: "timeout" });
          status = "budget_exhausted";
          break;
        }
        const result = await executeHostAction(config, browser, action);
        emit({
          type: "host_action",
          action,
          ok: result.ok,
          detail: result.ok ? { kind: result.kind } : undefined,
          error: result.ok ? undefined : result.error,
        });

        if (
          !result.ok &&
          result.code === "checkout_boundary"
        ) {
          emit({
            type: "checkout_boundary",
            detail: result.error ?? "checkout refused",
          });
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: clipToolResult(result),
        });
      }

      if (status === "budget_exhausted") break;

      if (stopAction) {
        reply = stopAction.summary;
        status = "stopped";
        break;
      }
    }

    if (modelCalls >= config.maxModelCalls && status === "stopped" && !reply) {
      emit({ type: "budget_exhausted", kind: "model" });
      status = "budget_exhausted";
    }
  } catch (e) {
    if (e instanceof SessionBudgetExceededError) {
      emit({ type: "budget_exhausted", kind: "timeout" });
      status = "budget_exhausted";
    } else {
      status = "error";
      reply = e instanceof Error ? e.message : String(e);
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ensure cleanup attempt */
      }
    }
    emit({ type: "session_end", sessionId, reason: status });
  }

  return {
    status,
    reply,
    hostSteps,
    modelCalls,
    sessionId,
    limits: REQUEST_INTERCEPTION_LIMITS,
  };
}