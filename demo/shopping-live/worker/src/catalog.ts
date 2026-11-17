import { catalogProduct } from "../../../shopping-merchant/src/catalog.js";

export type HostProduct = {
  id: string;
  name: string;
  priceMinor: number;
  currency: "USD";
};

/** Stillroom UI catalog; prices must match merchant SERVER_CATALOG. */
export function hostCatalogProduct(productId: string): HostProduct | null {
  const p = catalogProduct(productId);
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    priceMinor: p.priceMinor,
    currency: p.currency,
  };
}
