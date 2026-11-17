import puppeteer from "@cloudflare/puppeteer";
import type { HostAction } from "../actions.js";
import {
  CHECKOUT_CONTROL_LABELS,
  STILLROOM_CATALOG,
  type StillroomProductId,
} from "../catalog.js";
import type { ShoppingAgentConfig } from "../config.js";
import { merchantHostname } from "../config.js";
import {
  shouldAllowBrowserRequest,
  assertTrustedAbsoluteUrl,
  ActionRefusedError,
} from "../guard.js";
import { addToCartSelector } from "../selectors.js";
import type {
  BrowserLauncher,
  BrowserSessionPort,
  CartSnapshot,
  HostActionResult,
} from "../ports.js";
import { redactText } from "../redact.js";

type Page = Awaited<
  ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>
>;

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

async function readCartSnapshot(page: Page): Promise<CartSnapshot> {
  const items = await page.evaluate(() => {
    const root = document.querySelector("#cart .cart-list");
    if (!root) return [] as { productId: string; quantity: number }[];
    return Array.from(root.querySelectorAll("li")).map((li) => {
      const qty = Number(
        li.querySelector("span:nth-of-type(2)")?.textContent?.trim() ?? "0",
      );
      const name = li.querySelector("span")?.textContent?.trim() ?? "";
      return { productId: name.split(" ")[0] ?? "unknown", quantity: qty };
    });
  });
  return { items, checkoutAllowed: false };
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
        const text = await this.page.evaluate(() => {
          const grid = document.querySelector("#shop .grid");
          return grid?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        });
        void text;
        return {
          ok: true,
          kind: "view_catalog",
          catalog: {
            products: STILLROOM_CATALOG.map((p) => ({
              id: p.id,
              name: p.name,
              priceMinor: p.priceMinor,
              currency: p.currency,
            })),
          },
        };
      }
      case "add_to_cart": {
        await refuseCheckoutClicks(this.page);
        const selector = addToCartSelector(action.productId as StillroomProductId);
        const handle = await this.page.$(selector);
        if (!handle) {
          throw new ActionRefusedError(
            "selector_missing",
            `Add-to-cart control missing for ${action.productId}`,
          );
        }
        const label = await this.page.evaluate(
          (el) => (el as HTMLButtonElement).textContent?.trim() ?? "",
          handle,
        );
        if (label !== "Add to cart") {
          throw new ActionRefusedError(
            "checkout_boundary",
            `Refusing non-catalog control: ${redactText(label, 80)}`,
          );
        }
        await handle.click();
        return { ok: true, kind: "add_to_cart", productId: action.productId };
      }
      case "view_cart": {
        await refuseCheckoutClicks(this.page);
        const cart = await readCartSnapshot(this.page);
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
  return async ({ sessionId, merchantHostname: host, allowedDomains }) => {
    const browser = await puppeteer.launch(binding, {
      guardrails: { allowedDomains },
    });
    const page = await browser.newPage();
    await attachRequestPolicy(page, config);
    void host;
    void merchantHostname(config);
    return new PuppeteerBrowserSession(sessionId, config, browser, page);
  };
}

export type { PuppeteerBrowserSession };