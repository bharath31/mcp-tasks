// Real browser coverage for the built page and CSS. The access-state cases replace
// only the Auth0 adapter, leaving rendering, fetch handling and controls intact.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const web = new URL("../web/", import.meta.url);
let server, browser, origin;

before(async () => {
  const compiled = await build({
    entryPoints: [new URL("src/admin.ts", web).pathname],
    bundle: true,
    write: false,
    format: "esm",
    plugins: [
      {
        name: "test-auth",
        setup(b) {
          b.onResolve({ filter: /^\.\/auth$/ }, () => ({
            path: "auth",
            namespace: "test",
          }));
          b.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents: `
          export const loadConfig = async () => ({});
          export const initAuth = async () => ({authenticated: !location.search.includes('signed-out')});
          export const user = async () => ({email: 'operator@example.com'});
          export const idToken = async () => 'test-id-token';
          export const authedFetch = (path, init) => fetch(path, init);
          export const login = async (state) => { window.testLoginState = state; };
          export const logout = async () => {};
        `,
          }));
        },
      },
    ],
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/test-admin.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(compiled.outputFiles[0].text);
    }
    const path =
      url.pathname === "/admin" ? "admin.html" : url.pathname.slice(1);
    if (
      !/^(admin\.html|admin\.js|admin\.css|style\.css|chunks\/[\w-]+\.js)$/.test(
        path,
      )
    ) {
      res.writeHead(404).end();
      return;
    }
    try {
      let body = await readFile(new URL(`dist/${path}`, web));
      if (path === "admin.html" && url.searchParams.has("test"))
        body = Buffer.from(
          body.toString().replace('src="/admin.js"', 'src="/test-admin.js"'),
        );
      res.setHeader(
        "content-type",
        path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".js")
            ? "text/javascript"
            : "text/html",
      );
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
  });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
});

async function pageFor(viewport = { width: 1440, height: 1100 }) {
  const page = await browser.newPage({ viewport });
  // Fonts are incidental to these tests; system fallbacks work offline too.
  await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  return page;
}

test("built admin page supports desktop/mobile, search, ranges and chart metrics", async () => {
  for (const width of [1440, 390]) {
    const page = await pageFor({ width, height: 1100 });
    try {
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${origin}/admin?mock=1`);
      await page
        .getByRole("heading", { name: "Users 5", exact: true })
        .waitFor();
      assert.equal(await page.locator(".a-chart-svg .a-bar").count(), 14);
      assert.equal(await page.locator("#a-users-body tbody tr").count(), 5);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.equal(
        await page
          .locator(".a-kpis")
          .evaluate((el) => getComputedStyle(el).display),
        "grid",
      );
      if (process.env.ADMIN_SCREENSHOT_DIR) {
        await mkdir(process.env.ADMIN_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: `${process.env.ADMIN_SCREENSHOT_DIR}/admin-${width}.png`,
          fullPage: true,
        });
      }
      await page.getByRole("button", { name: "7d", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll(".a-chart-svg .a-bar").length === 7,
      );
      await page
        .getByRole("button", { name: "Model tokens", exact: true })
        .click();
      await page
        .getByRole("img", { name: "Model tokens per day, last 7 days" })
        .waitFor();
      await page.getByRole("searchbox", { name: "Search users" }).fill("MAYA");
      assert.equal(await page.locator("#a-users-body tbody tr").count(), 1);
      await page.getByRole("searchbox").fill("no-such-user");
      await page.getByText("No matches", { exact: true }).waitFor();
      await page.getByRole("searchbox").fill("");
      assert.equal(await page.locator("#a-users-body tbody tr").count(), 5);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  }
});

test("operator sign-in requests a return to /admin", async () => {
  const page = await pageFor();
  try {
    await page.goto(`${origin}/admin?test&signed-out`);
    await page.getByRole("button", { name: "Sign in with Auth0" }).click();
    assert.deepEqual(await page.evaluate(() => window.testLoginState), {
      returnTo: "/admin",
    });
  } finally {
    await page.close();
  }
});

test("refresh keeps data on network failure and removes it when access is revoked", async () => {
  const page = await pageFor();
  try {
    const data = {
      generatedAt: new Date().toISOString(),
      modelTracking: false,
      totals: { visitors: 0 },
      daily: [],
      users: [],
      recent: [],
    };
    let status = 200;
    await page.route("**/sandbox/admin/usage?*", (route) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(
          status === 200 ? data : { message: "Access denied" },
        ),
      }),
    );
    await page.goto(`${origin}/admin?test`);
    await page.getByText("No visitors yet", { exact: true }).waitFor();
    status = 500;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(
      await page.getByText("No visitors yet", { exact: true }).count(),
      1,
    );
    status = 403;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page
      .getByRole("heading", { name: "Not an operator account" })
      .waitFor();
    assert.equal(await page.locator(".a-kpis").count(), 0);
    status = 401;
    await page.goto(`${origin}/admin?test`);
    await page.getByRole("heading", { name: "Operator sign-in" }).waitFor();
  } finally {
    await page.close();
  }
});
