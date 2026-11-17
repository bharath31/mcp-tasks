import type { ShoppingAgentEvent } from "@nominee/shopping-agent";
import { sanitizePublicText, assertPublicBlobSafe } from "./sanitize.js";
import type { PublicRunEvent } from "./types.js";

export function shoppingEventToPublic(
  event: ShoppingAgentEvent,
  atMs: number,
  knownSecrets: readonly string[] = [],
): PublicRunEvent {
  const kind = event.type;
  const message = sanitizePublicText(summarizeEvent(event), 2000, knownSecrets);
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
export function assertPublicEventsSafe(
  events: PublicRunEvent[],
  knownSecrets: readonly string[] = [],
): void {
  let blob = JSON.stringify(events);
  for (const secret of knownSecrets) {
    if (secret.length >= 8 && blob.includes(secret)) {
      throw new Error("public_run_event_leak");
    }
  }
  try {
    assertPublicBlobSafe(blob);
  } catch {
    throw new Error("public_run_event_leak");
  }
}
