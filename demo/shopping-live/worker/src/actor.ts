import type { AgentActor } from "../../../shopping-merchant/src/types.js";
import type { ShoppingLiveEnv } from "./env.js";

/** Server-assigned browser shopping actor; never built from client JSON. */
export function browserShoppingActor(
  env: ShoppingLiveEnv,
  customerId: string,
  browserSessionId: string,
): AgentActor {
  const agentId =
    typeof env.SHOPPING_BROWSER_AGENT_ID === "string" &&
    env.SHOPPING_BROWSER_AGENT_ID.length > 0
      ? env.SHOPPING_BROWSER_AGENT_ID
      : "browser-shopping";
  return {
    kind: "agent",
    customerId,
    agentId,
    pairwiseUserId: customerId,
    sessionId: browserSessionId,
    scopes: ["cart:write", "checkout:write", "addresses:read"],
  };
}