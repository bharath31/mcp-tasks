import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SHOP_GRID_SELECTOR,
  SHOP_READY_SELECTOR,
  CART_LIST_SELECTOR,
} from "../../../shopping-agent/src/selectors.js";

const mainSrc = readFileSync(
  fileURLToPath(new URL("../src/main.ts", import.meta.url)),
  "utf8",
);

test("merchant DOM includes shopping-agent selector roots", () => {
  assert.match(mainSrc, /id: "shop"/);
  assert.match(mainSrc, /className: "grid"/);
  assert.match(mainSrc, /id: "cart"/);
  assert.match(mainSrc, /className: "cart-list"/);
  assert.equal(SHOP_GRID_SELECTOR, "#shop .grid");
  assert.equal(
    SHOP_READY_SELECTOR,
    "#shop .grid article button:not([disabled])",
  );
  assert.equal(CART_LIST_SELECTOR, "#cart .cart-list");
});

test("checkout controls are explicitly marked as boundaries", () => {
  assert.match(mainSrc, /data-nominee-checkout-boundary/);
  assert.match(mainSrc, /Review quote/);
  assert.match(mainSrc, /Complete checkout/);
});
