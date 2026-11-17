import { redactValue } from "./redact.js";
import type { HostAction } from "./actions.js";

/** Observable, model-safe progress events (no Live View URLs or secrets). */
export type ShoppingAgentEvent =
  | { type: "session_start"; sessionId: string; merchant: string }
  | { type: "session_end"; sessionId: string; reason: string }
  | { type: "model_start"; n: number }
  | { type: "model_done"; n: number; toolNames: string[] }
  | {
      type: "host_action";
      action: HostAction;
      ok: boolean;
      detail?: unknown;
      error?: string;
    }
  | { type: "budget_exhausted"; kind: "model" | "steps" | "timeout" }
  | { type: "checkout_boundary"; detail: string };

export function safeEvent(event: ShoppingAgentEvent): ShoppingAgentEvent {
  return redactValue(event) as ShoppingAgentEvent;
}