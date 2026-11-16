const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const executablePath =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
(async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  for (const width of [390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto("http://localhost:3187/?view=fixture");
    await page.getByText("Fixture presentation", { exact: false }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      width,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Available when connected" })
        .count(),
      4,
    );
    await page.screenshot({
      path: `/tmp/storefront-${width}.png`,
      fullPage: true,
    });
    await page.close();
  }
  const page = await browser.newPage();
  let quoteBody;
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const products = [
      {
        id: "p",
        name: "Test item",
        description: "Example",
        priceMinor: 2400,
        currency: "USD",
      },
    ];
    let body;
    if (path === "/api/catalog") body = { products };
    else if (path === "/api/session")
      body = {
        mode: "live",
        actor: { kind: "human", scopes: [] },
        capabilities: { directCustomerVerification: true },
      };
    else if (path === "/api/addresses")
      body = {
        addresses: [{ id: "a", label: "Home", trustedForAgentCheckout: true }],
      };
    else if (path === "/api/carts")
      body = { cart: { id: "c", items: [], version: 1 } };
    else if (path === "/api/carts/c/items")
      body = {
        cart: { id: "c", items: JSON.parse(req.postData()).items, version: 2 },
      };
    else if (path === "/api/carts/c/quote") {
      quoteBody = JSON.parse(req.postData());
      body = {
        quote: {
          id: "q",
          operationId: "o",
          revision: 1,
          cartId: "c",
          items: [{ name: "Test item", quantity: 1, priceMinor: 2400 }],
          subtotalMinor: 2400,
          taxMinor: 0,
          shippingMinor: 0,
          totalMinor: 2400,
          currency: "USD",
          destinationLabel: "Home",
          expiresAt: "2030-01-01T00:00:00Z",
          requirement: "customer_verification",
        },
      };
    } else if (path === "/api/checkouts/q/complete")
      body = { status: "processing" };
    else if (path === "/api/checkouts/q")
      body = {
        quote: {
          id: "q",
          revision: 1,
          items: [],
          subtotalMinor: 2400,
          taxMinor: 0,
          shippingMinor: 0,
          totalMinor: 2400,
          currency: "USD",
          expiresAt: "2030-01-01T00:00:00Z",
        },
      };
    else throw Error(`unexpected request: ${path}`);
    await route.fulfill({ json: body });
  });
  await page.goto("http://localhost:3187/");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await page.getByRole("button", { name: "Load saved addresses" }).click();
  await page.locator("#address").selectOption("a");
  await page.getByRole("button", { name: "Review quote" }).click();
  assert.deepEqual(quoteBody, { shippingAddressId: "a" });
  await page.getByRole("button", { name: "Complete checkout" }).click();
  await page.getByText("Processing.", { exact: false }).waitFor();
  await page.goto("http://localhost:3187/review/q");
  await page
    .getByText("Customer verification is not connected", { exact: false })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Verify and approve" }).count(),
    0,
  );
  await browser.close();
  console.log(
    "PASS: responsive fixture, mock cart/quote/processing, live review fail-closed",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
