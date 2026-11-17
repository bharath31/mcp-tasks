import type { ShoppingAgentConfig } from "./config.js";
import type { HostAction } from "./actions.js";
import { STILLROOM_CATALOG } from "./catalog.js";
import {
  ActionRefusedError,
  buildNavigationUrl,
} from "./guard.js";
import type { BrowserSessionPort, HostActionResult } from "./ports.js";

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
        return {
          ok: true,
          kind: "view_catalog",
          catalog: {
            products: STILLROOM_CATALOG.filter((p) =>
              config.productIds.includes(p.id),
            ).map((p) => ({
              id: p.id,
              name: p.name,
              priceMinor: p.priceMinor,
              currency: p.currency,
            })),
          },
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
    if (e instanceof ActionRefusedError) {
      return { ok: false, error: e.message, code: e.code };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}