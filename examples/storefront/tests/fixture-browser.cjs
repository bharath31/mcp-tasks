const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 900 },
    });
    await page.goto("http://127.0.0.1:3187");
    await page
      .getByText("Fixture identity · purchases are simulated")
      .waitFor();
    await page.getByRole("button", { name: "Add to cart" }).first().click();
    await page
      .getByRole("button", { name: "Grant fixture account access" })
      .click();
    await page.getByRole("button", { name: "Load saved addresses" }).click();
    await page.locator("#address").selectOption("fixture-home");
    await page.getByRole("button", { name: "Review quote" }).click();
    await page.getByRole("button", { name: "Complete checkout" }).click();
    await page
      .getByRole("button", { name: "Confirm exact fixture quote" })
      .click();
    await page.getByRole("button", { name: "Complete checkout" }).click();
    await page.getByRole("heading", { name: "Order completed" }).waitFor();
    await page.screenshot({
      path: "/tmp/shopping-fixture-mobile.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Retry completion" }).click();
    await page.getByRole("button", { name: "Add one Mug" }).click();
    await page.getByRole("button", { name: "Add one Mug" }).click();
    await page.getByRole("button", { name: "Add one Mug" }).click();
    await page.getByRole("button", { name: "Review quote" }).click();
    await page.getByRole("button", { name: "Complete checkout" }).click();
    const [review] = await Promise.all([
      page.waitForEvent("popup"),
      page
        .getByRole("link", { name: "Open the merchant’s review page" })
        .click(),
    ]);
    await review
      .getByRole("button", { name: "Switch to fixture customer (simulated)" })
      .click();
    await review
      .getByRole("button", { name: "Record fixture review (simulated)" })
      .click();
    await review.getByText("Review recorded.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Resume fixture agent" }).click();
    await page.getByRole("button", { name: "Complete checkout" }).click();
    await page.getByRole("heading", { name: "Order completed" }).waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({
      path: "/tmp/shopping-fixture-desktop.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      1440,
    );
    console.log(
      "PASS actual fixture backend: low-risk and customer-review orders",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
