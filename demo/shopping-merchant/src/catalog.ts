import type { CatalogProduct } from "./types.js";

/** Server-owned catalog; clients cannot supply prices or product metadata. */
export const SERVER_CATALOG: readonly CatalogProduct[] = Object.freeze([
  Object.freeze({
    id: "mug",
    name: "Mug",
    description: "Ceramic mug",
    priceMinor: 1800,
    currency: "USD" as const,
  }),
  Object.freeze({
    id: "tea",
    name: "Tea",
    description: "Loose leaf tea",
    priceMinor: 1200,
    currency: "USD" as const,
  }),
]);

export function catalogProduct(productId: string): CatalogProduct | undefined {
  return SERVER_CATALOG.find((p) => p.id === productId);
}