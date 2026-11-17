import { PRODUCT_GRID_INDEX, type StillroomProductId } from "./catalog.js";

export function addToCartSelector(productId: StillroomProductId): string {
  const nth = PRODUCT_GRID_INDEX[productId];
  return `#shop .grid article:nth-child(${nth}) > button`;
}