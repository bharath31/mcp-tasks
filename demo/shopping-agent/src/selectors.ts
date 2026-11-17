import type { StillroomProductId } from "./catalog.js";
import { productNameForId } from "./dom.js";

/** Host-owned grid roots on the reference Stillroom storefront. */
export const SHOP_GRID_SELECTOR = "#shop .grid";
export const SHOP_READY_SELECTOR =
  "#shop .grid article button:not([disabled])";
export const CART_LIST_SELECTOR = "#cart .cart-list";

export function expectedProductDisplayName(productId: StillroomProductId): string {
  return productNameForId(productId);
}