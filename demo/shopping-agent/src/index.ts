export {
  shoppingAgentConfig,
  merchantHostname,
  trustedUrl,
  type ShoppingAgentConfig,
} from "./config.js";
export {
  STILLROOM_CATALOG,
  STILLROOM_PRODUCT_IDS,
  CHECKOUT_CONTROL_LABELS,
  type StillroomProductId,
} from "./catalog.js";
export {
  hostAction,
  AGENT_TOOLS,
  PERMITTED_TOOL_NAMES,
  actionFromToolCall,
  type HostAction,
} from "./actions.js";
export {
  assertAllowedNavigation,
  assertTrustedAbsoluteUrl,
  shouldAllowBrowserRequest,
  ActionRefusedError,
  REQUEST_INTERCEPTION_LIMITS,
} from "./guard.js";
export { redactText, redactValue } from "./redact.js";
export { safeEvent, type ShoppingAgentEvent } from "./events.js";
export type {
  BrowserSessionPort,
  BrowserLauncher,
  BrowserInitCookie,
  ModelPort,
  ModelMessage,
  HostActionResult,
} from "./ports.js";
export { executeHostAction } from "./executor.js";
export { expectedProductDisplayName, SHOP_GRID_SELECTOR } from "./selectors.js";
export {
  buildCatalogFromGrid,
  buildCartFromDom,
  CATALOG_PRICE_DISCLAIMER,
} from "./dom.js";
export {
  runShoppingAgent,
  shoppingRequest,
  type ShoppingRequest,
  type ShoppingAgentResult,
} from "./agent.js";
export {
  createWorkersAiModel,
  parseWorkersAiOutput,
  type WorkersAiBinding,
} from "./model/workers-ai-adapter.js";
export { createPuppeteerLauncher } from "./browser/puppeteer-adapter.js";
