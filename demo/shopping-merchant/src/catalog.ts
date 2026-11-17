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
  Object.freeze({
    id: "tray",
    name: "Catchall tray",
    description: "A quiet place for the things you reach for.",
    priceMinor: 2400,
    currency: "USD" as const,
  }),
  Object.freeze({
    id: "cup",
    name: "Pencil cup",
    description: "A little order for your desk.",
    priceMinor: 1800,
    currency: "USD" as const,
  }),
  Object.freeze({
    id: "book",
    name: "Daily notebook",
    description: "Blank pages for plans and loose thoughts.",
    priceMinor: 1600,
    currency: "USD" as const,
  }),
  Object.freeze({
    id: "weight",
    name: "Paper weight",
    description: "Keep the important page in place.",
    priceMinor: 3200,
    currency: "USD" as const,
  }),
]);

export function catalogProduct(productId: string): CatalogProduct | undefined {
  return SERVER_CATALOG.find((p) => p.id === productId);
}
