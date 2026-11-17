import type { ShoppingAgentConfig } from "./config.js";
import type { HostAction } from "./actions.js";
import type { StillroomProductId } from "./catalog.js";
import { CATALOG_PRICE_DISCLAIMER } from "./dom.js";
import { ActionRefusedError, buildNavigationUrl } from "./guard.js";
import type { BrowserSessionPort, HostActionResult } from "./ports.js";
import { SessionBudgetExceededError } from "./session-budget.js";

export async function executeHostAction(
  config: ShoppingAgentConfig,
  browser: BrowserSessionPort,
  action: HostAction,
): Promise<HostActionResult> {
  try {
    switch (action.kind) {
      case "navigate": {
        const url = buildNavigationUrl(config, action.path, action.hash);
        await browser.gotoTrusted(url);
        return { ok: true, kind: "navigate", url };
      }
      case "view_catalog": {
        const result = await browser.runHostAction(action);
        if (!result.ok) return result;
        if (result.kind !== "view_catalog") {
          return {
            ok: false,
            error: "unexpected host response for view_catalog",
          };
        }
        return {
          ok: true,
          kind: "view_catalog",
          catalog: {
            products: result.catalog.products.filter((p) =>
              config.productIds.includes(p.id as StillroomProductId),
            ),
          },
          disclaimer: CATALOG_PRICE_DISCLAIMER,
        };
      }
      case "add_to_cart": {
        if (!config.productIds.includes(action.productId)) {
          throw new ActionRefusedError(
            "product_denied",
            `Product not enabled: ${action.productId}`,
          );
        }
        const result = await browser.runHostAction(action);
        if (!result.ok) return result;
        return { ok: true, kind: "add_to_cart", productId: action.productId };
      }
      case "view_cart":
        return browser.runHostAction(action);
      case "stop":
        return { ok: true, kind: "stop", summary: action.summary };
      default: {
        const _exhaustive: never = action;
        throw new ActionRefusedError("unknown_action", String(_exhaustive));
      }
    }
  } catch (e) {
    if (e instanceof SessionBudgetExceededError) {
      throw e;
    }
    if (e instanceof ActionRefusedError) {
      return { ok: false, error: e.message, code: e.code };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
