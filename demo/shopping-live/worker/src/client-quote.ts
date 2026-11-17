import type { Quote as MerchantQuote } from "../../../shopping-merchant/src/types.js";
import { buildGuardianPurchaseAuthorizationDetails } from "../../../shopping-merchant/src/approval/guardian-transaction-details.js";
import { stableDestinationJson } from "../../../shopping-merchant/src/approval/serialize.js";
import type { ClientCartItem, ClientQuote } from "./cart.js";

export function merchantQuoteToClient(
  quote: MerchantQuote,
  merchantDisplayName: string,
  nowMs = Date.now(),
): ClientQuote {
  const detailsJson = stableDestinationJson(quote.destination.destination);
  const verified = nowMs < Date.parse(quote.expiresAt);
  buildGuardianPurchaseAuthorizationDetails({
    quote,
    merchantDisplayName,
    nowMs,
  });
  return {
    id: quote.id,
    cartId: quote.cartId,
    revision: quote.revision,
    items: quote.items.map(
      (item): ClientCartItem => ({
        productId: item.productId,
        quantity: item.quantity,
        name: item.name,
        priceMinor: item.priceMinor,
        currency: item.currency,
      }),
    ),
    subtotalMinor: quote.subtotalMinor,
    taxMinor: quote.taxMinor,
    shippingMinor: quote.shippingMinor,
    totalMinor: quote.totalMinor,
    currency: quote.currency,
    expiresAt: quote.expiresAt,
    verified,
    destination: {
      id: quote.destination.id,
      label: quote.destination.label,
      detailsJson,
    },
  };
}