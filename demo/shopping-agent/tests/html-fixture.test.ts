import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseHTML } from "linkedom";
import { STILLROOM_PRODUCT_IDS } from "../src/catalog.js";
import {
  assertUniqueGridProductName,
  buildCartFromDom,
  buildCatalogFromGrid,
} from "../src/dom.js";
import {
  countExactGridProductNames,
  scrapeCartLinesFromDocument,
  scrapeGridArticlesFromDocument,
} from "../src/browser/storefront-dom.js";
import {
  CART_LIST_SELECTOR,
  SHOP_GRID_SELECTOR,
  SHOP_READY_SELECTOR,
} from "../src/selectors.js";
import { waitForShopGridReady } from "../src/browser/grid-waits.js";
import { ActionRefusedError } from "../src/guard.js";
import { createSessionBudget } from "../src/session-budget.js";

const fixtureHtml = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "stillroom-shop.html",
  ),
  "utf8",
);

function loadFixture(html = fixtureHtml) {
  const { document } = parseHTML(html);
  return document;
}

test("fixture scrape matches Stillroom selectors (reversed grid order)", () => {
  const doc = loadFixture();
  const articles = scrapeGridArticlesFromDocument(doc, SHOP_GRID_SELECTOR);
  assert.equal(articles.length, 4);
  const { products } = buildCatalogFromGrid(articles, STILLROOM_PRODUCT_IDS);
  assert.deepEqual(
    products.map((p) => p.id),
    ["weight", "book", "cup", "tray"],
  );
  assert.equal(doc.querySelectorAll(SHOP_READY_SELECTOR).length, 3);
});

test("fixture cart lines parse host-owned ids", () => {
  const doc = loadFixture();
  const lines = scrapeCartLinesFromDocument(doc, CART_LIST_SELECTOR);
  const { items, errors } = buildCartFromDom(lines, STILLROOM_PRODUCT_IDS);
  assert.deepEqual(errors, []);
  assert.deepEqual(items, [
    { productId: "tray", quantity: 2 },
    { productId: "cup", quantity: 1 },
  ]);
});

test("duplicate exact product names fail closed before add", () => {
  const doc = loadFixture();
  const grid = doc.querySelector("#shop .grid");
  assert.ok(grid);
  const dup = doc.createElement("article");
  dup.innerHTML = `
    <div class="product-heading"><h3>Catchall tray</h3><b>$24.00</b></div>
    <button>Add to cart</button>`;
  grid.appendChild(dup);
  const articles = scrapeGridArticlesFromDocument(doc, SHOP_GRID_SELECTOR);
  const name = "Catchall tray";
  const count = countExactGridProductNames(articles, name);
  assert.equal(count, 2);
  const unique = assertUniqueGridProductName(name, count);
  assert.ok("error" in unique);
  assert.match(unique.error, /duplicate product name/i);
});

test("invalid displayed prices stay null in catalog reconciliation", () => {
  const doc = loadFixture();
  const article = doc.querySelector("#shop .grid article");
  assert.ok(article);
  const price = article.querySelector(".product-heading b");
  assert.ok(price);
  price.textContent = "Price on request";
  const articles = scrapeGridArticlesFromDocument(doc, SHOP_GRID_SELECTOR);
  const { products } = buildCatalogFromGrid(articles, ["weight"]);
  assert.equal(products[0]?.priceMinor, null);
});

test("waitForShopGridReady awaits selectors instead of immediate query", async () => {
  const calls: string[] = [];
  const page = {
    async waitForSelector(selector: string) {
      calls.push(selector);
      if (selector.includes("article button")) {
        throw new Error("not ready yet");
      }
      return {};
    },
  };
  const t0 = 1_000_000;
  const budget = createSessionBudget(t0, 60_000, () => t0);
  await assert.rejects(
    () => waitForShopGridReady(page, budget, 5_000),
    (e: unknown) => {
      assert.ok(e instanceof ActionRefusedError);
      assert.equal(e.code, "shop_not_ready");
      return true;
    },
  );
  assert.deepEqual(calls[0], "#shop .grid");
  assert.ok(calls.includes(SHOP_READY_SELECTOR));
});

test("delayed hydration: grid appears after waitForSelector resolves", async () => {
  let hydrated = false;
  const page = {
    async waitForSelector(selector: string) {
      if (selector === "#shop .grid" && !hydrated) {
        hydrated = true;
        return {};
      }
      if (selector === SHOP_READY_SELECTOR) {
        if (!hydrated) throw new Error("missing grid");
        return {};
      }
      return {};
    },
  };
  const budget = createSessionBudget(Date.now(), 60_000);
  await waitForShopGridReady(page, budget, 5_000);
  assert.equal(hydrated, true);
});
