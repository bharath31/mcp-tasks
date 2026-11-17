import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { TEST_CUSTOMER } from "../../../shopping-merchant/tests/support/identity-jwt.js";
import {
  MERCHANT_ORIGIN,
  ORIGIN,
  apiJson,
  startHarness,
  type Harness,
} from "../../worker/tests/support/harness.js";
import { startLocalHttpsGateway } from "../../worker/tests/support/local-https-gateway.js";

const dist = join(fileURLToPath(new URL("..", import.meta.url)), "dist");
const executablePath =
  process.env.CHROME_PATH ||
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined);

function parseCookieValue(cookieHeader: string): string {
  const eq = cookieHeader.indexOf("=");
  return decodeURIComponent(cookieHeader.slice(eq + 1));
}

/**
 * Local Chromium against Miniflare + built storefront — not Cloudflare Browser Run.
 */
test("agent capability storefront uses agent-browser cart API and merges ledger cart", async (t) => {
  if (!existsSync(join(dist, "index.html"))) {
    t.skip("dist/ missing — run npm run build in demo/shopping-live/web first");
  }
  if (!executablePath || !existsSync(executablePath)) {
    t.skip("local Chromium not available (set CHROME_PATH)");
  }

  const harness: Harness = await startHarness({
    serveAssets: true,
    secureStorefrontOrigin: true,
  });
  const gateway = await startLocalHttpsGateway(harness.mf, MERCHANT_ORIGIN);

  let browser: Browser | undefined;
  try {
    const { cookie, csrf } = await harness.login(TEST_CUSTOMER);
    const seeded = await apiJson(harness.mf, "/api/cart/items", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: MERCHANT_ORIGIN,
        "x-nominee-csrf": csrf,
      },
      cookie,
      body: JSON.stringify({ productId: "cup", quantity: 1 }),
    });
    assert.equal(seeded.status, 200);

    const cap = await harness.mintAgentCap(TEST_CUSTOMER, csrf);
    const capValue = parseCookieValue(cap.cookie);

    browser = await chromium.launch({
      headless: true,
      executablePath,
    });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
    });
    await context.addCookies([
      {
        name: "nsh_agent_cap",
        value: capValue,
        url: `${MERCHANT_ORIGIN}/api/agent-browser/`,
      },
    ]);

    const page = await context.newPage();
    const apiPaths: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.pathname.startsWith("/api/")) {
        apiPaths.push(url.pathname);
      }
    });

    await page.goto(`${MERCHANT_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await page
      .locator('[data-product-id="tray"] button')
      .getByText("Add to cart")
      .click();

    await page.waitForFunction(() => {
      const items = Array.from(
        document.querySelectorAll("#cart .cart-list li"),
      ).map((n) => n.textContent ?? "");
      return items.some((t) => t.includes("Catchall tray"));
    });

    assert.ok(
      apiPaths.some((p) => p === "/api/agent-browser/cart/items"),
      `expected agent-browser add; saw ${apiPaths.join(", ")}`,
    );
    assert.equal(
      apiPaths.filter((p) => p === "/api/cart/items").length,
      0,
      "storefront must not call customer /api/cart/items when agent-browser is active",
    );

    const sessionProbe = await apiJson(
      harness.mf,
      "/api/agent-browser/session",
      { cookie: cap.cookie },
    );
    assert.equal(sessionProbe.status, 200);

    const blocked = await apiJson(harness.mf, "/api/cart/items", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: MERCHANT_ORIGIN,
      },
      cookie: cap.cookie,
      body: JSON.stringify({ productId: "book", quantity: 1 }),
    });
    assert.equal(blocked.status, 401);

    const customerCart = await apiJson<{
      cart?: { items?: { productId: string }[] };
    }>(harness.mf, "/api/cart", { cookie });
    const productIds = (customerCart.body.cart?.items ?? []).map(
      (i) => i.productId,
    );
    assert.ok(productIds.includes("cup"));
    assert.ok(productIds.includes("tray"));
  } finally {
    await browser?.close();
    await gateway.close();
    await harness.mf.dispose();
  }
});
