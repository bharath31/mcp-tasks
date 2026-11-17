import { ActionRefusedError } from "../guard.js";
import { SHOP_GRID_SELECTOR, SHOP_READY_SELECTOR } from "../selectors.js";
import {
  assertWithinBudget,
  capWaitMs,
  type SessionBudget,
} from "../session-budget.js";

export type PageLike = {
  waitForSelector(
    selector: string,
    opts: { timeout: number },
  ): Promise<unknown>;
};

export async function waitForShopGridReady(
  page: PageLike,
  budget: SessionBudget,
  defaultWaitMs: number,
): Promise<void> {
  const timeoutMs = capWaitMs(budget, defaultWaitMs);
  try {
    await page.waitForSelector(SHOP_GRID_SELECTOR, { timeout: timeoutMs });
  } catch {
    throw new ActionRefusedError(
      "selector_missing",
      "Shop grid is not present on the page",
    );
  }
  assertWithinBudget(budget);
  const readyTimeout = capWaitMs(budget, defaultWaitMs);
  try {
    await page.waitForSelector(SHOP_READY_SELECTOR, { timeout: readyTimeout });
  } catch {
    throw new ActionRefusedError(
      "shop_not_ready",
      "Shop grid is not ready (session or products still loading)",
    );
  }
}
