import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGuardianPurchaseAuthorizationDetails } from "../../../shopping-merchant/src/approval/guardian-transaction-details.js";
import type { Quote } from "../../../shopping-merchant/src/types.js";
import { merchantQuoteToClient } from "../src/client-quote.js";

const MERCHANT = "Stillroom";

function sampleQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: "quote-read-1",
    operationId: "op-1",
    revision: 1,
    cartId: "cart-1",
    cartVersion: 1,
    customerId: "cust_1",
    agentId: null,
    items: [
      {
        productId: "cup",
        name: "Cup",
        quantity: 2,
        priceMinor: 1200,
        currency: "USD",
      },
    ],
    subtotalMinor: 2400,
    taxMinor: 0,
    shippingMinor: 0,
    totalMinor: 2400,
    currency: "USD",
    destination: {
      id: "addr-1",
      customerId: "cust_1",
      label: "Home",
      version: "v1",
      trustedForAgentCheckout: true,
      destination: { country: "US", postalCode: "94105" },
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
    requirement: "customer_verification",
    ...overrides,
  };
}

test("merchantQuoteToClient skips Guardian validation when quote is expired", () => {
  const nowMs = Date.parse("2100-01-01T00:00:00.000Z");
  const client = merchantQuoteToClient(
    sampleQuote({ expiresAt: "2099-06-01T00:00:00.000Z" }),
    MERCHANT,
    nowMs,
  );
  assert.equal(client.verified, false);
});

test("client quote monetary fields match Guardian authorization_details", () => {
  const quote = sampleQuote();
  const nowMs = Date.parse("2025-01-01T00:00:00.000Z");
  const client = merchantQuoteToClient(quote, MERCHANT, nowMs);
  const details = buildGuardianPurchaseAuthorizationDetails({
    quote,
    merchantDisplayName: MERCHANT,
    nowMs,
  });
  assert.equal(details.properties.subtotal_minor?.value, client.subtotalMinor);
  assert.equal(details.properties.total_minor?.value, client.totalMinor);
  assert.equal(details.properties.tax_minor?.value, client.taxMinor);
  assert.equal(details.properties.shipping_minor?.value, client.shippingMinor);
  assert.equal(details.properties.currency?.value, client.currency);
  assert.equal(
    details.properties.item_0_unit_price_minor?.value,
    client.items[0]!.priceMinor,
  );
  assert.equal(
    details.properties.destination_details?.value,
    client.destination.detailsJson,
  );
});
