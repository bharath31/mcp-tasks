import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGuardianPurchaseAuthorizationDetails,
  GUARDIAN_PURCHASE_AUTHORIZATION_DETAILS_TYPE,
  GuardianTransactionDetailsError,
} from "../src/approval/index.js";
import type { Quote } from "../src/types.js";

const MERCHANT = "Nominee Fixture Shop";

function fakeQuote(overrides: Partial<Quote> = {}): Quote {
  const base: Quote = {
    id: "quote-1",
    operationId: "op-1",
    revision: 1,
    cartId: "cart-1",
    cartVersion: 1,
    customerId: "customer-1",
    agentId: "agent-1",
    items: [
      {
        productId: "mug",
        name: "Mug",
        quantity: 2,
        priceMinor: 1800,
        currency: "USD",
      },
    ],
    subtotalMinor: 3600,
    taxMinor: 200,
    shippingMinor: 500,
    totalMinor: 4300,
    currency: "USD",
    destination: {
      id: "addr-1",
      customerId: "customer-1",
      label: "Home",
      version: "v1",
      trustedForAgentCheckout: true,
      destination: { country: "US", postalCode: "10001" },
    },
    expiresAt: new Date("2099-06-01T00:00:00.000Z").toISOString(),
    requirement: "customer_verification",
  };
  return { ...base, ...overrides };
}

function encodeFingerprint(
  details: ReturnType<typeof buildGuardianPurchaseAuthorizationDetails>,
) {
  return JSON.stringify(details);
}

test("maps quote into Auth0 Guardian purchase authorization_details", () => {
  const details = buildGuardianPurchaseAuthorizationDetails({
    quote: fakeQuote(),
    merchantDisplayName: MERCHANT,
    nowMs: Date.parse("2098-01-01T00:00:00.000Z"),
  });
  assert.equal(details.type, GUARDIAN_PURCHASE_AUTHORIZATION_DETAILS_TYPE);
  assert.match(details.instruction, /Nominee Fixture Shop/);
  assert.equal(details.properties.merchant?.value, MERCHANT);
  assert.equal(details.properties.total_minor?.value, 4300);
  assert.equal(details.properties.total?.value, "USD 43.00");
  assert.equal(details.properties.item_0_unit_price_minor?.value, 1800);
  assert.equal(
    details.properties.destination_details?.value,
    '{"country":"US","postalCode":"10001"}',
  );
  assert.equal(details.properties.agent_id?.value, "agent-1");
});

test("omits agent binding when quote has no agentId", () => {
  const details = buildGuardianPurchaseAuthorizationDetails({
    quote: fakeQuote({ agentId: null }),
    merchantDisplayName: MERCHANT,
    nowMs: Date.parse("2098-01-01T00:00:00.000Z"),
  });
  assert.equal(details.properties.agent_id, undefined);
});

test("changing purchase terms changes encoded authorization_details", () => {
  const nowMs = Date.parse("2098-01-01T00:00:00.000Z");
  const a = buildGuardianPurchaseAuthorizationDetails({
    quote: fakeQuote(),
    merchantDisplayName: MERCHANT,
    nowMs,
  });
  const b = buildGuardianPurchaseAuthorizationDetails({
    quote: fakeQuote({
      items: [
        {
          productId: "mug",
          name: "Mug (revised)",
          quantity: 2,
          priceMinor: 1800,
          currency: "USD",
        },
      ],
    }),
    merchantDisplayName: MERCHANT,
    nowMs,
  });
  assert.notEqual(encodeFingerprint(a), encodeFingerprint(b));
});

test("destination serialization is deterministic for key order", () => {
  const quote = fakeQuote({
    destination: {
      id: "addr-2",
      customerId: "customer-1",
      label: "Office",
      version: "v2",
      trustedForAgentCheckout: false,
      destination: { postalCode: "94105", country: "US", unit: "4B" },
    },
  });
  const details = buildGuardianPurchaseAuthorizationDetails({
    quote,
    merchantDisplayName: MERCHANT,
    nowMs: Date.parse("2098-01-01T00:00:00.000Z"),
  });
  assert.equal(
    details.properties.destination_details?.value,
    '{"country":"US","postalCode":"94105","unit":"4B"}',
  );
});

test("fail closed on total mismatch", () => {
  assert.throws(
    () =>
      buildGuardianPurchaseAuthorizationDetails({
        quote: fakeQuote({ totalMinor: 9999 }),
        merchantDisplayName: MERCHANT,
        nowMs: Date.parse("2098-01-01T00:00:00.000Z"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_quote");
      return true;
    },
  );
});

test("fail closed on expired quote", () => {
  assert.throws(
    () =>
      buildGuardianPurchaseAuthorizationDetails({
        quote: fakeQuote({
          expiresAt: new Date("2020-01-01T00:00:00.000Z").toISOString(),
        }),
        merchantDisplayName: MERCHANT,
        nowMs: Date.parse("2098-01-01T00:00:00.000Z"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "quote_expired");
      return true;
    },
  );
});

test("fail closed on line subtotal overflow", () => {
  assert.throws(
    () =>
      buildGuardianPurchaseAuthorizationDetails({
        quote: fakeQuote({
          items: [
            {
              productId: "x",
              name: "X",
              quantity: Number.MAX_SAFE_INTEGER,
              priceMinor: 2,
              currency: "USD",
            },
          ],
          subtotalMinor: 0,
        }),
        merchantDisplayName: MERCHANT,
        nowMs: Date.parse("2098-01-01T00:00:00.000Z"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      return true;
    },
  );
});

test("fail closed on unsupported destination values", () => {
  assert.throws(
    () =>
      buildGuardianPurchaseAuthorizationDetails({
        quote: fakeQuote({
          destination: {
            ...fakeQuote().destination,
            destination: { note: Symbol("secret") as unknown as string },
          },
        }),
        merchantDisplayName: MERCHANT,
        nowMs: Date.parse("2098-01-01T00:00:00.000Z"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_destination");
      return true;
    },
  );
});

test("fail closed on empty merchant display name", () => {
  assert.throws(
    () =>
      buildGuardianPurchaseAuthorizationDetails({
        quote: fakeQuote(),
        merchantDisplayName: "   ",
        nowMs: Date.parse("2098-01-01T00:00:00.000Z"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_merchant");
      return true;
    },
  );
});
