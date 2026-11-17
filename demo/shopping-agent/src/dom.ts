import {
  STILLROOM_CATALOG,
  type StillroomProductId,
} from "./catalog.js";

/** Host-owned exact display names for allowlisted product ids. */
export const ALLOWED_PRODUCT_NAME: Record<StillroomProductId, string> =
  Object.fromEntries(STILLROOM_CATALOG.map((p) => [p.id, p.name])) as Record<
    StillroomProductId,
    string
  >;

export type GridArticleSnapshot = {
  name: string;
  priceText: string;
  buttonLabel: string;
  buttonDisabled: boolean;
};

export type CartLineSnapshot = {
  /** Text of the first direct child span (name + optional price). */
  nameLine: string;
  quantityText: string;
};

export type ReconciledCatalogProduct = {
  id: StillroomProductId;
  name: string;
  priceMinor: number | null;
  currency: string | null;
};

export function parseDisplayedPriceMinor(
  priceText: string,
): { priceMinor: number; currency: string } | null {
  const t = priceText.trim();
  const m = t.match(/^\$([\d,]+(?:\.\d{2})?)$/);
  if (!m) return null;
  const dollars = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(dollars)) return null;
  return { priceMinor: Math.round(dollars * 100), currency: "USD" };
}

export function reconcileExactProductName(
  displayName: string,
  enabledIds: readonly StillroomProductId[],
): { id: StillroomProductId } | { error: string } {
  const name = displayName.trim();
  if (!name) return { error: "empty product name" };
  const matches = enabledIds.filter((id) => ALLOWED_PRODUCT_NAME[id] === name);
  if (matches.length === 1) return { id: matches[0]! };
  if (matches.length > 1) return { error: `ambiguous product name: ${name}` };
  return { error: `unsupported product name: ${name}` };
}

/** Fail closed when the live grid shows the same display name more than once. */
export function assertUniqueGridProductName(
  displayName: string,
  matchCount: number,
): { ok: true } | { error: string } {
  if (matchCount === 0) {
    return { error: `product not on shop grid: ${displayName.trim()}` };
  }
  if (matchCount > 1) {
    return { error: `duplicate product name on shop grid: ${displayName.trim()}` };
  }
  return { ok: true };
}

export function productNameForId(
  productId: StillroomProductId,
): string {
  return ALLOWED_PRODUCT_NAME[productId];
}

export function buildCatalogFromGrid(
  articles: GridArticleSnapshot[],
  enabledIds: readonly StillroomProductId[],
): { products: ReconciledCatalogProduct[]; errors: string[] } {
  const products: ReconciledCatalogProduct[] = [];
  const errors: string[] = [];
  const seen = new Set<StillroomProductId>();

  for (const article of articles) {
    const reconciled = reconcileExactProductName(article.name, enabledIds);
    if ("error" in reconciled) {
      if (article.name.trim()) errors.push(reconciled.error);
      continue;
    }
    if (seen.has(reconciled.id)) {
      errors.push(`duplicate catalog entry for ${reconciled.id}`);
      continue;
    }
    seen.add(reconciled.id);
    const parsed = parseDisplayedPriceMinor(article.priceText);
    products.push({
      id: reconciled.id,
      name: article.name.trim(),
      priceMinor: parsed?.priceMinor ?? null,
      currency: parsed?.currency ?? null,
    });
  }

  return { products, errors };
}

export function prepareCatalogForHost(
  products: ReconciledCatalogProduct[],
  gridErrors: string[],
):
  | {
      ok: true;
      catalogProducts: {
        id: string;
        name: string;
        priceMinor: number;
        currency: string;
      }[];
    }
  | { ok: false; error: string } {
  const priceErrors: string[] = [];
  const catalogProducts: {
    id: string;
    name: string;
    priceMinor: number;
    currency: string;
  }[] = [];
  for (const p of products) {
    if (p.priceMinor == null || p.currency == null) {
      priceErrors.push(`invalid displayed price for ${p.id}`);
      continue;
    }
    catalogProducts.push({
      id: p.id,
      name: p.name,
      priceMinor: p.priceMinor,
      currency: p.currency,
    });
  }
  const allErrors = [...gridErrors, ...priceErrors];
  if (allErrors.length > 0) {
    return { ok: false, error: allErrors.join("; ") };
  }
  if (!catalogProducts.length) {
    return { ok: false, error: "No catalog products on page" };
  }
  return { ok: true, catalogProducts };
}

/** Strip a trailing currency amount from a cart line name span. */
export function cartLineDisplayName(nameLine: string): string {
  const t = nameLine.trim();
  const withoutPrice = t.replace(/\s+\$[\d,]+(?:\.\d{2})?$/, "").trim();
  return withoutPrice || t;
}

export function buildCartFromDom(
  lines: CartLineSnapshot[],
  enabledIds: readonly StillroomProductId[],
): { items: { productId: StillroomProductId; quantity: number }[]; errors: string[] } {
  const items: { productId: StillroomProductId; quantity: number }[] = [];
  const errors: string[] = [];

  for (const line of lines) {
    const displayName = cartLineDisplayName(line.nameLine);
    const reconciled = reconcileExactProductName(displayName, enabledIds);
    if ("error" in reconciled) {
      errors.push(reconciled.error);
      continue;
    }
    const qty = Number(line.quantityText.trim());
    if (!Number.isFinite(qty) || qty < 0) {
      errors.push(`invalid quantity for ${displayName}`);
      continue;
    }
    items.push({ productId: reconciled.id, quantity: qty });
  }

  return { items, errors };
}

export const CATALOG_PRICE_DISCLAIMER =
  "Displayed prices are informational only and are not merchant authorization to charge.";