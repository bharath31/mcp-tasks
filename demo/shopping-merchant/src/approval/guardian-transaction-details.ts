import { GUARDIAN_PURCHASE_AUTHORIZATION_DETAILS_TYPE } from "./constants.js";
import { formatUsdMinor } from "./format.js";
import { stableDestinationJson } from "./serialize.js";
import type {
  BuildGuardianPurchaseAuthorizationDetailsInput,
  GuardianAuthorizationProperty,
  GuardianPurchaseAuthorizationDetails,
} from "./types.js";
import {
  GuardianTransactionDetailsError,
  validateQuoteForGuardianDetails,
} from "./validate.js";

function prop(
  name: string,
  display_order: number,
  value: string | number | boolean,
  display = true,
  description?: string,
): GuardianAuthorizationProperty {
  return {
    display,
    name,
    display_order,
    value,
    ...(description ? { description } : {}),
  };
}

/**
 * Maps a trusted merchant quote into Auth0 Guardian `authorization_details` schema.
 * Offline only: no CIBA, push, proof, or tenant calls.
 */
export function buildGuardianPurchaseAuthorizationDetails(
  input: BuildGuardianPurchaseAuthorizationDetailsInput,
): GuardianPurchaseAuthorizationDetails {
  const merchantDisplayName = input.merchantDisplayName;
  if (typeof merchantDisplayName !== "string") {
    throw new GuardianTransactionDetailsError(
      "invalid_merchant",
      "merchantDisplayName must be a string",
    );
  }
  if (merchantDisplayName !== merchantDisplayName.trim()) {
    throw new GuardianTransactionDetailsError(
      "invalid_merchant",
      "merchantDisplayName must not have leading or trailing whitespace",
    );
  }
  if (!merchantDisplayName) {
    throw new GuardianTransactionDetailsError(
      "invalid_merchant",
      "merchantDisplayName must be non-empty",
    );
  }

  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) {
    throw new GuardianTransactionDetailsError(
      "invalid_input",
      "nowMs must be a finite number",
    );
  }
  validateQuoteForGuardianDetails(input.quote, nowMs);

  const quote = input.quote;
  const properties: Record<string, GuardianAuthorizationProperty> = {};
  let order = 1;

  const add = (
    key: string,
    name: string,
    value: string | number | boolean,
    description?: string,
  ) => {
    properties[key] = prop(name, order, value, true, description);
    order += 1;
  };

  add("merchant", "Merchant", merchantDisplayName);
  add("quote_id", "Quote", quote.id);
  add("operation_id", "Operation", quote.operationId);
  add("quote_revision", "Quote revision", quote.revision);
  add("expires_at", "Quote expires", quote.expiresAt);
  add("customer_id", "Customer", quote.customerId);
  add("cart_id", "Cart", quote.cartId);
  add("cart_version", "Cart version", quote.cartVersion);
  if (quote.agentId !== null) {
    add("agent_id", "Agent", quote.agentId);
  }

  quote.items.forEach((item, index) => {
    const prefix = `item_${index}`;
    add(`${prefix}_product_id`, `Item ${index + 1} id`, item.productId);
    add(`${prefix}_name`, `Item ${index + 1} name`, item.name);
    add(`${prefix}_quantity`, `Item ${index + 1} quantity`, item.quantity);
    add(
      `${prefix}_unit_price_minor`,
      `Item ${index + 1} unit price (minor)`,
      item.priceMinor,
    );
    add(
      `${prefix}_unit_price`,
      `Item ${index + 1} unit price`,
      formatUsdMinor(item.priceMinor),
    );
    add(
      `${prefix}_line_total_minor`,
      `Item ${index + 1} line total (minor)`,
      item.quantity * item.priceMinor,
    );
  });

  add("subtotal_minor", "Subtotal (minor)", quote.subtotalMinor);
  add("subtotal", "Subtotal", formatUsdMinor(quote.subtotalMinor));
  add("tax_minor", "Tax (minor)", quote.taxMinor);
  add("tax", "Tax", formatUsdMinor(quote.taxMinor));
  add("shipping_minor", "Shipping (minor)", quote.shippingMinor);
  add("shipping", "Shipping", formatUsdMinor(quote.shippingMinor));
  add("total_minor", "Total (minor)", quote.totalMinor);
  add("total", "Total", formatUsdMinor(quote.totalMinor));
  add("currency", "Currency", quote.currency);

  const dest = quote.destination;
  add("destination_id", "Ship-to id", dest.id);
  add("destination_customer_id", "Ship-to customer", dest.customerId);
  add("destination_label", "Ship-to label", dest.label);
  add("destination_version", "Ship-to version", dest.version);
  add(
    "destination_trusted_for_agent_checkout",
    "Trusted for agent checkout",
    dest.trustedForAgentCheckout,
  );
  add(
    "destination_details",
    "Ship-to address",
    stableDestinationJson(dest.destination),
  );
  add("approval_requirement", "Approval requirement", quote.requirement);

  const instruction = `Review and approve this purchase from ${merchantDisplayName} for ${formatUsdMinor(quote.totalMinor)}.`;

  return {
    type: GUARDIAN_PURCHASE_AUTHORIZATION_DETAILS_TYPE,
    instruction,
    properties,
  };
}
