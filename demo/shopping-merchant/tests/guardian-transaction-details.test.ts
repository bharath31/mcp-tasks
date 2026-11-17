import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGuardianPurchaseAuthorizationDetails,
  GUARDIAN_PURCHASE_AUTHORIZATION_DETAILS_TYPE,
  GuardianTransactionDetailsError,
  stableDestinationJson,
} from "../src/approval/index.js";
import { DESTINATION_JSON_MAX_NODES } from "../src/approval/serialize.js";
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
  assert.match(details.instruction, /USD 43\.00/);
  assert.equal(details.properties.merchant?.value, MERCHANT);
  assert.equal(details.properties.cart_id?.value, "cart-1");
  assert.equal(details.properties.cart_version?.value, 1);
  assert.equal(details.properties.destination_customer_id?.value, "customer-1");
  assert.equal(
    details.properties.approval_requirement?.value,
    "customer_verification",
  );
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

test("fail closed on material string whitespace without silent normalization", () => {
  assert.throws(
    () =>
      buildGuardianPurchaseAuthorizationDetails({
        quote: fakeQuote({ id: "  quote-1  " }),
        merchantDisplayName: MERCHANT,
        nowMs: Date.parse("2098-01-01T00:00:00.000Z"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_quote");
      assert.match(String(err.message), /whitespace/);
      return true;
    },
  );
});

test("fail closed on subtotal mismatch", () => {
  assert.throws(
    () =>
      buildGuardianPurchaseAuthorizationDetails({
        quote: fakeQuote({ subtotalMinor: 1 }),
        merchantDisplayName: MERCHANT,
        nowMs: Date.parse("2098-01-01T00:00:00.000Z"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_quote");
      assert.match(String(err.message), /subtotalMinor/);
      return true;
    },
  );
});

test("fail closed on non-USD quote currency", () => {
  assert.throws(
    () =>
      buildGuardianPurchaseAuthorizationDetails({
        quote: fakeQuote({ currency: "EUR" as Quote["currency"] }),
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

test("fail closed when destination customer does not match quote customer", () => {
  assert.throws(
    () =>
      buildGuardianPurchaseAuthorizationDetails({
        quote: fakeQuote({
          customerId: "customer-a",
          destination: {
            ...fakeQuote().destination,
            customerId: "customer-b",
          },
        }),
        merchantDisplayName: MERCHANT,
        nowMs: Date.parse("2098-01-01T00:00:00.000Z"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_quote");
      assert.match(String(err.message), /must match/);
      return true;
    },
  );
});

test("fail closed on non-finite nowMs", () => {
  assert.throws(
    () =>
      buildGuardianPurchaseAuthorizationDetails({
        quote: fakeQuote(),
        merchantDisplayName: MERCHANT,
        nowMs: Number.NaN,
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_input");
      return true;
    },
  );
});

test("fail closed on Date object inside destination.destination", () => {
  assert.throws(
    () =>
      buildGuardianPurchaseAuthorizationDetails({
        quote: fakeQuote({
          destination: {
            ...fakeQuote().destination,
            destination: { shippedAt: new Date() as unknown as string },
          },
        }),
        merchantDisplayName: MERCHANT,
        nowMs: Date.parse("2098-01-01T00:00:00.000Z"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.ok(
        err.code === "invalid_quote" || err.code === "invalid_destination",
      );
      return true;
    },
  );
});

test("stableDestinationJson preserves __proto__ own key from JSON.parse", () => {
  const parsed = JSON.parse('{"__proto__":{"x":1},"country":"US"}') as Record<
    string,
    unknown
  >;
  assert.equal(
    stableDestinationJson(parsed),
    '{"__proto__":{"x":1},"country":"US"}',
  );
});

test("stableDestinationJson rejects accessor properties without invoking getters", () => {
  const bad = { country: "US" };
  let invoked = false;
  Object.defineProperty(bad, "leak", {
    enumerable: true,
    get() {
      invoked = true;
      return "x";
    },
  });
  assert.throws(
    () => stableDestinationJson(bad),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_destination");
      return true;
    },
  );
  assert.equal(invoked, false);
});

test("stableDestinationJson rejects cyclic references", () => {
  const cycle: Record<string, unknown> = { country: "US" };
  cycle.child = cycle;
  assert.throws(
    () => stableDestinationJson(cycle),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_destination");
      assert.match(String(err.message), /cyclic/);
      return true;
    },
  );
});

test("stableDestinationJson rejects sparse arrays", () => {
  const sparse = [1];
  sparse[2] = 3;
  assert.throws(
    () =>
      stableDestinationJson({
        lines: sparse,
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_destination");
      assert.match(String(err.message), /sparse/);
      return true;
    },
  );
});

test("stableDestinationJson enforces shared node cap across branching subtrees", () => {
  const destination: Record<string, unknown> = { country: "US" };
  for (let i = 0; i < 100; i += 1) {
    destination[`branch_${i}`] = {
      a: Array.from({ length: 50 }, (_, j) => j),
    };
  }
  assert.throws(
    () => stableDestinationJson(destination),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_destination");
      assert.match(
        String(err.message),
        new RegExp(String(DESTINATION_JSON_MAX_NODES)),
      );
      return true;
    },
  );
});

test("stableDestinationJson rejects array index getters without invoking them", () => {
  const arr: unknown[] = [1];
  let invoked = false;
  Object.defineProperty(arr, "0", {
    enumerable: true,
    configurable: true,
    get() {
      invoked = true;
      return 99;
    },
  });
  assert.throws(
    () => stableDestinationJson({ lines: arr }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_destination");
      assert.match(String(err.message), /accessor/);
      return true;
    },
  );
  assert.equal(invoked, false);
});

test("stableDestinationJson rejects prototype-chain array indices", () => {
  const child = ["x"];
  Object.setPrototypeOf(child, ["a", "b"]);
  child.length = 2;
  assert.equal(Object.hasOwn(child, "1"), false);
  assert.equal(1 in child, true);
  assert.throws(
    () => stableDestinationJson({ lines: child }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_destination");
      assert.match(String(err.message), /sparse|inherited|Array prototype/);
      return true;
    },
  );
});

test("stableDestinationJson rejects array non-index own properties", () => {
  const arr = [1] as unknown[] & { meta?: string };
  arr.meta = "bar";
  assert.throws(
    () => stableDestinationJson({ lines: arr }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_destination");
      assert.match(String(err.message), /non-index/);
      return true;
    },
  );
});

test("stableDestinationJson rejects symbol keys on arrays", () => {
  const arr = [1] as unknown[] & Record<symbol, number>;
  arr[Symbol.for("x")] = 2;
  assert.throws(
    () => stableDestinationJson({ lines: arr }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_destination");
      assert.match(String(err.message), /symbol/);
      return true;
    },
  );
});

test("stableDestinationJson rejects inherited sparse slots", () => {
  const parentArray: unknown[] = [];
  parentArray[1] = "inherited";
  const child = ["x"];
  Object.setPrototypeOf(child, parentArray);
  child.length = 2;
  assert.throws(
    () => stableDestinationJson({ lines: child }),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_destination");
      assert.match(String(err.message), /sparse|inherited|Array prototype/);
      return true;
    },
  );
});

test("stableDestinationJson rejects plain objects with prototype toJSON", () => {
  const bad = Object.create({
    toJSON() {
      return { hacked: true };
    },
  });
  bad.country = "US";
  assert.throws(
    () => stableDestinationJson(bad),
    (err: unknown) => {
      assert.ok(err instanceof GuardianTransactionDetailsError);
      assert.equal(err.code, "invalid_destination");
      assert.match(String(err.message), /toJSON/);
      return true;
    },
  );
});
