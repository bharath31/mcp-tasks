import puppeteer from "@cloudflare/puppeteer";
import type { HostAction } from "../actions.js";
import { CHECKOUT_CONTROL_LABELS, type StillroomProductId } from "../catalog.js";
import type { ShoppingAgentConfig } from "../config.js";
import {
  buildCartFromDom,
  buildCatalogFromGrid,
  type CartLineSnapshot,
  type GridArticleSnapshot,
} from "../dom.js";
import {
  shouldAllowBrowserRequest,
  assertTrustedAbsoluteUrl,
  ActionRefusedError,
} from "../guard.js";
import {
  CART_LIST_SELECTOR,
  expectedProductDisplayName,
  SHOP_GRID_SELECTOR,
  SHOP_READY_SELECTOR,
} from "../selectors.js";
import type {
  BrowserLauncher,
  BrowserSessionPort,
  CartSnapshot,
  HostActionResult,
} from "../ports.js";
type Page = Awaited<
  ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>
>;

const GRID_WAIT_MS = 20_000;
const CART_POLL_MS = 8_000;
const CART_POLL_INTERVAL_MS = 250;

async function attachRequestPolicy(
  page: Page,
  config: ShoppingAgentConfig,
): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (shouldAllowBrowserRequest(config, url)) {
      void req.continue();
      return;
    }
    void req.abort("blockedbyclient");
  });
}

async function refuseCheckoutClicks(page: Page): Promise<void> {
  await page.evaluate((labels: string[]) => {
    for (const btn of Array.from(document.querySelectorAll("button"))) {
      const text = (btn.textContent ?? "").trim();
      if (labels.includes(text)) {
        btn.setAttribute("disabled", "true");
        btn.setAttribute("data-nominee-checkout-boundary", "true");
      }
    }
  }, [...CHECKOUT_CONTROL_LABELS]);
}

async function waitForShopGridReady(page: Page, timeoutMs: number): Promise<void> {
  const grid = await page.$(SHOP_GRID_SELECTOR);
  if (!grid) {
    throw new ActionRefusedError(
      "selector_missing",
      "Shop grid is not present on the page",
    );
  }
  try {
    await page.waitForSelector(SHOP_READY_SELECTOR, { timeout: timeoutMs });
  } catch {
    throw new ActionRefusedError(
      "shop_not_ready",
      "Shop grid is not ready (session or products still loading)",
    );
  }
}

async function scrapeGridArticles(page: Page): Promise<GridArticleSnapshot[]> {
  return page.evaluate((gridSel) => {
    const grid = document.querySelector(gridSel);
    if (!grid) return [];
    return Array.from(grid.querySelectorAll("article")).map((article) => {
      const name =
        article.querySelector(".product-heading h3")?.textContent?.trim() ?? "";
      const priceText =
        article.querySelector(".product-heading b")?.textContent?.trim() ?? "";
      const button = article.querySelector("button");
      return {
        name,
        priceText,
        buttonLabel: (button?.textContent ?? "").trim(),
        buttonDisabled: Boolean(
          button?.hasAttribute("disabled") || (button as HTMLButtonElement | null)?.disabled,
        ),
      };
    });
  }, SHOP_GRID_SELECTOR);
}

async function scrapeCartLines(page: Page): Promise<CartLineSnapshot[]> {
  return page.evaluate((listSel) => {
    const root = document.querySelector(listSel);
    if (!root) return [];
    return Array.from(root.querySelectorAll("li")).map((li) => ({
      nameLine: li.querySelector(":scope > span")?.textContent?.trim() ?? "",
      quantityText:
        li.querySelector("div > span")?.textContent?.trim() ?? "0",
    }));
  }, CART_LIST_SELECTOR);
}

async function readCartSnapshot(
  page: Page,
  config: ShoppingAgentConfig,
): Promise<CartSnapshot> {
  const lines = await scrapeCartLines(page);
  const { items, errors } = buildCartFromDom(lines, config.productIds);
  if (errors.length) {
    throw new ActionRefusedError(
      "cart_parse",
      `Could not parse cart: ${errors.join("; ")}`,
    );
  }
  return { items, checkoutAllowed: false };
}

async function clickAddToCartForProduct(
  page: Page,
  productId: StillroomProductId,
  expectedName: string,
): Promise<void> {
  const clicked = await page.evaluate(
    ({ gridSel, name, label }) => {
      const grid = document.querySelector(gridSel);
      if (!grid) return { ok: false as const, reason: "grid_missing" };
      for (const article of Array.from(grid.querySelectorAll("article"))) {
        const h3 = article.querySelector(".product-heading h3")?.textContent?.trim();
        if (h3 !== name) continue;
        const button = article.querySelector("button");
        if (!button) return { ok: false as const, reason: "button_missing" };
        if (button.hasAttribute("disabled") || (button as HTMLButtonElement).disabled) {
          return { ok: false as const, reason: "button_disabled" };
        }
        const text = (button.textContent ?? "").trim();
        if (text !== label) {
          return { ok: false as const, reason: `bad_label:${text}` };
        }
        button.click();
        return { ok: true as const };
      }
      return { ok: false as const, reason: "product_missing" };
    },
    { gridSel: SHOP_GRID_SELECTOR, name: expectedName, label: "Add to cart" },
  );

  if (!clicked.ok) {
    if (clicked.reason.startsWith("bad_label")) {
      throw new ActionRefusedError(
        "checkout_boundary",
        "Refusing non-catalog add control",
      );
    }
    throw new ActionRefusedError(
      "add_failed",
      `Could not add ${productId}: ${clicked.reason}`,
    );
  }
}

async function waitForCartIncrease(
  page: Page,
  config: ShoppingAgentConfig,
  productId: StillroomProductId,
  beforeQty: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const cart = await readCartSnapshot(page, config);
      const after = cart.items.find((i) => i.productId === productId)?.quantity ?? 0;
      if (after > beforeQty) return true;
    } catch {
      /* cart may not be ready yet */
    }
    await new Promise((r) => setTimeout(r, CART_POLL_INTERVAL_MS));
  }
  return false;
}

class PuppeteerBrowserSession implements BrowserSessionPort {
  constructor(
    readonly sessionId: string,
    private readonly config: ShoppingAgentConfig,
    private browser: Awaited<ReturnType<typeof puppeteer.launch>>,
    private page: Page,
  ) {}

  async gotoTrusted(url: string): Promise<void> {
    assertTrustedAbsoluteUrl(this.config, url);
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await refuseCheckoutClicks(this.page);
    if (url.includes("#shop") || (await this.page.$(SHOP_GRID_SELECTOR))) {
      await waitForShopGridReady(this.page, GRID_WAIT_MS);
    }
  }

  async runHostAction(action: HostAction): Promise<HostActionResult> {
    switch (action.kind) {
      case "navigate":
        return {
          ok: false,
          error: "navigate through BrowserSession.gotoTrusted",
        };
      case "view_catalog": {
        await refuseCheckoutClicks(this.page);
        await waitForShopGridReady(this.page, GRID_WAIT_MS);
        const articles = await scrapeGridArticles(this.page);
        const { products, errors } = buildCatalogFromGrid(
          articles,
          this.config.productIds,
        );
        if (!products.length && errors.length) {
          return {
            ok: false,
            error: errors.join("; "),
            code: "catalog_parse",
          };
        }
        return {
          ok: true,
          kind: "view_catalog",
          catalog: {
            products: products.map((p) => ({
              id: p.id,
              name: p.name,
              priceMinor: p.priceMinor ?? 0,
              currency: p.currency ?? "USD",
            })),
          },
        };
      }
      case "add_to_cart": {
        await refuseCheckoutClicks(this.page);
        await waitForShopGridReady(this.page, GRID_WAIT_MS);
        const expectedName = expectedProductDisplayName(action.productId);
        const articles = await scrapeGridArticles(this.page);
        const inGrid = articles.some((a) => a.name === expectedName);
        if (!inGrid) {
          throw new ActionRefusedError(
            "product_missing",
            `Product not visible on shop grid: ${action.productId}`,
          );
        }
        const cartBefore = await readCartSnapshot(this.page, this.config);
        const beforeQty =
          cartBefore.items.find((i) => i.productId === action.productId)?.quantity ?? 0;

        await clickAddToCartForProduct(
          this.page,
          action.productId,
          expectedName,
        );

        const increased = await waitForCartIncrease(
          this.page,
          this.config,
          action.productId,
          beforeQty,
          CART_POLL_MS,
        );
        if (!increased) {
          return {
            ok: false,
            error: `Cart quantity did not increase for ${action.productId}`,
            code: "add_unverified",
          };
        }
        return { ok: true, kind: "add_to_cart", productId: action.productId };
      }
      case "view_cart": {
        await refuseCheckoutClicks(this.page);
        const cart = await readCartSnapshot(this.page, this.config);
        return { ok: true, kind: "view_cart", cart };
      }
      case "stop":
        return { ok: true, kind: "stop", summary: action.summary };
      default:
        return { ok: false, error: "unknown action" };
    }
  }

  async close(): Promise<void> {
    try {
      await this.page.close();
    } catch {
      /* page may already be gone */
    }
    await this.browser.close();
  }
}

export function createPuppeteerLauncher(
  binding: Fetcher,
  config: ShoppingAgentConfig,
): BrowserLauncher {
  return async ({ sessionId, allowedDomains }) => {
    const browser = await puppeteer.launch(binding, {
      guardrails: { allowedDomains },
    });
    try {
      const page = await browser.newPage();
      await attachRequestPolicy(page, config);
      return new PuppeteerBrowserSession(sessionId, config, browser, page);
    } catch (e) {
      try {
        await browser.close();
      } catch {
        /* launch partially failed */
      }
      throw e;
    }
  };
}

export type { PuppeteerBrowserSession };