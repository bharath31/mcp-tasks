import { redactText } from "../../shopping-agent/src/redact.js";
import type { ShoppingAgentEvent } from "../../shopping-agent/src/events.js";
import type { PublicRunEvent } from "./types.js";

const FORBIDDEN_IN_MESSAGE =
  /bearer|authorization:|cf-brapi-live-view|api[_-]?key|password/i;

export function shoppingEventToPublic(
  event: ShoppingAgentEvent,
  atMs: number,
): PublicRunEvent {
  const kind = event.type;
  let message = summarizeEvent(event);
  message = redactText(message, 2000);
  if (FORBIDDEN_IN_MESSAGE.test(message)) {
    message = "[redacted]";
  }
  return { atMs, kind, message };
}

function summarizeEvent(event: ShoppingAgentEvent): string {
  switch (event.type) {
    case "session_start":
      return `session ${event.sessionId} on ${event.merchant}`;
    case "session_end":
      return `session ${event.sessionId} ended: ${event.reason}`;
    case "model_start":
      return `model call ${event.n}`;
    case "model_done":
      return `model ${event.n} tools: ${event.toolNames.join(", ") || "(none)"}`;
    case "host_action":
      return event.ok
        ? `host ${event.action.kind} ok`
        : `host ${event.action.kind} failed: ${event.error ?? "error"}`;
    case "budget_exhausted":
      return `budget exhausted (${event.kind})`;
    case "checkout_boundary":
      return `checkout boundary: ${event.detail}`;
    default:
      return "progress";
  }
}

/** Fail closed if serialized public events would leak credential material. */
export function assertPublicEventsSafe(events: PublicRunEvent[]): void {
  const blob = JSON.stringify(events);
  if (FORBIDDEN_IN_MESSAGE.test(blob)) {
    throw new Error("public_run_event_leak");
  }
}