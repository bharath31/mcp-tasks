/** Host-owned Stillroom Supply catalog mirror (examples/storefront samples). */
export const STILLROOM_PRODUCT_IDS = [
  "tray",
  "cup",
  "book",
  "weight",
] as const;

export type StillroomProductId = (typeof STILLROOM_PRODUCT_IDS)[number];

export type CatalogProduct = {
  id: StillroomProductId;
  name: string;
  priceMinor: number;
  currency: "USD";
};

export const STILLROOM_CATALOG: readonly CatalogProduct[] = [
  {
    id: "tray",
    name: "Catchall tray",
    priceMinor: 2400,
    currency: "USD",
  },
  { id: "cup", name: "Pencil cup", priceMinor: 1800, currency: "USD" },
  { id: "book", name: "Daily notebook", priceMinor: 1600, currency: "USD" },
  { id: "weight", name: "Paper weight", priceMinor: 3200, currency: "USD" },
] as const;

/**
 * Fixed DOM mapping for the reference storefront grid (#shop .grid article).
 * The model cannot supply selectors; only these indices are clickable.
 */
export const PRODUCT_GRID_INDEX: Record<StillroomProductId, number> = {
  tray: 1,
  cup: 2,
  book: 3,
  weight: 4,
};

/** Buttons that mark the checkout boundary — host refuses to click these. */
export const CHECKOUT_CONTROL_LABELS = [
  "Review quote",
  "Complete checkout",
  "Confirm exact fixture quote",
  "Grant fixture account access",
  "Resume fixture agent",
] as const;