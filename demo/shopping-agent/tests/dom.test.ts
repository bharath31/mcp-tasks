import assert from "node:assert/strict";
import test from "node:test";
import { STILLROOM_PRODUCT_IDS } from "../src/catalog.js";
import {
  assertUniqueGridProductName,
  buildCartFromDom,
  buildCatalogFromGrid,
  prepareCatalogForHost,
  parseDisplayedPriceMinor,
  reconcileExactProductName,
  type CartLineSnapshot,
  type GridArticleSnapshot,
} from "../src/dom.js";
import { countExactGridProductNames } from "../src/browser/storefront-dom.js";
import { expectedProductDisplayName } from "../src/selectors.js";

const canonicalGrid: GridArticleSnapshot[] = [
  {
    name: "Catchall tray",
    priceText: "$24.00",
    buttonLabel: "Add to cart",
    buttonDisabled: false,
  },
  {
    name: "Pencil cup",
    priceText: "$18.00",
    buttonLabel: "Add to cart",
    buttonDisabled: false,
  },
  {
    name: "Daily notebook",
    priceText: "$16.00",
    buttonLabel: "Add to cart",
    buttonDisabled: true,
  },
  {
    name: "Paper weight",
    priceText: "$32.00",
    buttonLabel: "Add to cart",
    buttonDisabled: false,
  },
];

/** API may return reversed order; host maps by exact name, not grid index. */
const reversedGrid: GridArticleSnapshot[] = [...canonicalGrid].reverse();

test("parseDisplayedPriceMinor reads storefront currency format", () => {
  assert.deepEqual(parseDisplayedPriceMinor("$24.00"), {
    priceMinor: 2400,
    currency: "USD",
  });
  assert.equal(parseDisplayedPriceMinor("n/a"), null);
});

test("reconcileExactProductName rejects unknown and ambiguous names", () => {
  assert.deepEqual(
    reconcileExactProductName("Catchall tray", STILLROOM_PRODUCT_IDS),
    {
      id: "tray",
    },
  );
  assert.ok(
    "error" in reconcileExactProductName("Mystery mug", STILLROOM_PRODUCT_IDS),
  );
});

test("buildCatalogFromGrid uses live order and displayed prices", () => {
  const { products } = buildCatalogFromGrid(
    reversedGrid,
    STILLROOM_PRODUCT_IDS,
  );
  assert.deepEqual(
    products.map((p) => p.id),
    ["weight", "book", "cup", "tray"],
  );
  assert.equal(products.find((p) => p.id === "tray")?.priceMinor, 2400);
});

test("buildCatalogFromGrid still lists products when add buttons are disabled", () => {
  const disabledOnly = canonicalGrid.map((a) => ({
    ...a,
    buttonDisabled: true,
  }));
  const { products } = buildCatalogFromGrid(disabledOnly, ["book"]);
  assert.equal(products.length, 1);
  assert.equal(products[0]!.id, "book");
});

test("buildCartFromDom matches Stillroom cart markup shape", () => {
  const lines: CartLineSnapshot[] = [
    { nameLine: "Catchall tray $24.00", quantityText: "2" },
    { nameLine: "Pencil cup $18.00", quantityText: "1" },
  ];
  const { items, errors } = buildCartFromDom(lines, STILLROOM_PRODUCT_IDS);
  assert.deepEqual(errors, []);
  assert.deepEqual(items, [
    { productId: "tray", quantity: 2 },
    { productId: "cup", quantity: 1 },
  ]);
});

test("buildCartFromDom rejects bogus first-word heuristics", () => {
  const lines: CartLineSnapshot[] = [
    { nameLine: "Catchall tray $24.00", quantityText: "not-a-number" },
  ];
  const { items, errors } = buildCartFromDom(lines, STILLROOM_PRODUCT_IDS);
  assert.equal(items.length, 0);
  assert.match(errors[0] ?? "", /invalid quantity/i);
});

test("host-owned product display names are fixed per id", () => {
  assert.equal(expectedProductDisplayName("tray"), "Catchall tray");
});

test("buildCatalogFromGrid does not coerce invalid prices to zero", () => {
  const badPrice: GridArticleSnapshot[] = [
    {
      name: "Catchall tray",
      priceText: "TBD",
      buttonLabel: "Add to cart",
      buttonDisabled: false,
    },
  ];
  const { products } = buildCatalogFromGrid(badPrice, ["tray"]);
  assert.equal(products[0]?.priceMinor, null);
});

test("prepareCatalogForHost fails when any reconciled row lacks a live price", () => {
  const { products, errors } = buildCatalogFromGrid(
    [
      {
        name: "Catchall tray",
        priceText: "$24.00",
        buttonLabel: "Add to cart",
        buttonDisabled: false,
      },
      {
        name: "Pencil cup",
        priceText: "TBD",
        buttonLabel: "Add to cart",
        buttonDisabled: false,
      },
    ],
    STILLROOM_PRODUCT_IDS,
  );
  const prepared = prepareCatalogForHost(products, errors);
  assert.equal(prepared.ok, false);
  if (!prepared.ok) {
    assert.match(prepared.error, /invalid displayed price/);
  }
});

test("assertUniqueGridProductName blocks duplicate live names", () => {
  const grid = [
    ...canonicalGrid,
    { ...canonicalGrid[0]!, name: "Catchall tray" },
  ];
  assert.equal(countExactGridProductNames(grid, "Catchall tray"), 2);
  assert.ok("error" in assertUniqueGridProductName("Catchall tray", 2));
});
