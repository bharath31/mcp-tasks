/** Static Stillroom Supply catalog for display — prices load from markup for agents. */
export type StoreProduct = {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: "USD";
  image: string;
};

export const STORE_PRODUCTS: readonly StoreProduct[] = [
  {
    id: "tray",
    name: "Catchall tray",
    description: "A quiet place for the things you reach for.",
    priceMinor: 2400,
    currency: "USD",
    image: "/tray.svg",
  },
  {
    id: "cup",
    name: "Pencil cup",
    description: "A little order for your desk.",
    priceMinor: 1800,
    currency: "USD",
    image: "/cup.svg",
  },
  {
    id: "book",
    name: "Daily notebook",
    description: "Blank pages for plans and loose thoughts.",
    priceMinor: 1600,
    currency: "USD",
    image: "/book.svg",
  },
  {
    id: "weight",
    name: "Paper weight",
    description: "Keep the important page in place.",
    priceMinor: 3200,
    currency: "USD",
    image: "/weight.svg",
  },
] as const;

export function formatMoney(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(minor / 100);
}