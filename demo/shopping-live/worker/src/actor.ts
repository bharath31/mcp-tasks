import { ORDER_EXECUTE_SCOPE } from "../../../shopping-merchant/src/ledger.js";
import type { AgentActor } from "../../../shopping-merchant/src/types.js";
import type { ShoppingLiveEnv } from "./env.js";

/** Agent-browser HTTP surface: cart mutation only; no checkout or execute scopes. */
export function agentBrowserCartActor(
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
    scopes: ["cart:write"],
  };
}

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

/**
 * Host-only checkout actor: same browser session as {@link browserShoppingActor} plus
 * {@link ORDER_EXECUTE_SCOPE}. Built only on the verified Worker path after session + quote checks;
 * never accepted from client JSON.
 */
export function orderExecuteActor(
  env: ShoppingLiveEnv,
  customerId: string,
  browserSessionId: string,
): AgentActor {
  const base = browserShoppingActor(env, customerId, browserSessionId);
  if (base.scopes.includes(ORDER_EXECUTE_SCOPE)) return base;
  return { ...base, scopes: [...base.scopes, ORDER_EXECUTE_SCOPE] };
}
