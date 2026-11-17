const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const dist = join(__dirname, "..", "dist");
const executablePath =
  process.env.CHROME_PATH ||
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined);

if (!existsSync(join(dist, "index.html"))) {
  console.error("dist/ missing — run npm run build first");
  process.exit(1);
}

const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
};

function serveFile(pathname) {
  const safe = pathname === "/" ? "/index.html" : pathname;
  const file = join(dist, safe);
  if (!file.startsWith(dist) || !existsSync(file)) return null;
  const ext = safe.slice(safe.lastIndexOf("."));
  return {
    body: readFileSync(file),
    type: mime[ext] || "application/octet-stream",
  };
}

async function main() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: "shopping_unavailable",
          message: "API not wired in static test server",
        }),
      );
      return;
    }
    const file = serveFile(url.pathname);
    if (!file) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": file.type });
    res.end(file.body);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const launchOpts = { headless: true };
  if (executablePath && existsSync(executablePath))
    launchOpts.executablePath = executablePath;

  const browser = await chromium.launch(launchOpts);

  for (const width of [390, 768, 1200]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByRole("heading", { name: "Simulator" }).waitFor();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    assert.equal(overflow, true, `horizontal overflow at ${width}px`);
    const quote = page.getByRole("button", { name: "Review quote" });
    assert.equal(await quote.isDisabled(), true);
    const checkout = page.getByRole("button", { name: "Complete checkout" });
    assert.equal(await checkout.isDisabled(), true);
    await page.screenshot({
      path: join(dist, `screenshot-${width}.png`),
      fullPage: true,
    });
    await page.close();
  }

  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  console.log("browser tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});