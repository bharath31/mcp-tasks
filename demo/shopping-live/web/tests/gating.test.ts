import assert from "node:assert/strict";
import test from "node:test";
import {
  canExecuteOrder,
  canRequestQuote,
  canStartAgent,
  canStartApproval,
  sessionVerified,
} from "../src/gating.js";
import type {
  ApprovalRecord,
  Cart,
  Quote,
  SessionResponse,
} from "../src/types.js";

const authed: SessionResponse = {
  authenticated: true,
  customerId: "cust_1",
  loginUrl: "/login",
  logoutUrl: "/logout",
  merchant: { mode: "simulated", label: "Stillroom wallet" },
};

const cart: Cart = {
  id: "cart_1",
  items: [{ productId: "tray", quantity: 1 }],
};

const quote: Quote = {
  id: "q1",
  cartId: "cart_1",
  revision: 1,
  items: cart.items,
  subtotalMinor: 2400,
  taxMinor: 0,
  shippingMinor: 0,
  totalMinor: 2400,
  currency: "USD",
  expiresAt: "2030-01-01T00:00:00Z",
  verified: true,
};

const pending: ApprovalRecord = {
  id: "a1",
  quoteId: "q1",
  status: "pending",
};

const approved: ApprovalRecord = { ...pending, status: "approved" };

test("sessionVerified requires authenticated customer id", () => {
  assert.equal(sessionVerified(null), false);
  assert.equal(sessionVerified({ authenticated: false }), false);
  assert.equal(sessionVerified({ authenticated: true }), false);
  assert.equal(sessionVerified(authed), true);
});

test("checkout gates fail closed without server state", () => {
  assert.equal(canStartAgent(null), "no_session");
  assert.equal(canStartAgent({ authenticated: false }), "unauthenticated");
  assert.equal(
    canStartAgent({ authenticated: true }),
    "unauthenticated",
    "verified customer id required",
  );
  assert.equal(canStartAgent(authed), "ok");

  assert.equal(canRequestQuote(authed, null), "no_cart");
  assert.equal(canRequestQuote(authed, { id: "c", items: [] }), "empty_cart");
  assert.equal(canRequestQuote(authed, cart), "ok");

  assert.equal(canStartApproval(authed, null), "no_quote");
  assert.equal(
    canStartApproval(authed, { ...quote, verified: false }),
    "quote_unverified",
  );
  assert.equal(canStartApproval(authed, quote), "ok");

  assert.equal(canExecuteOrder(authed, quote, null), "no_approval");
  assert.equal(canExecuteOrder(authed, quote, pending), "approval_pending");
  assert.equal(canExecuteOrder(authed, quote, approved), "ok");
});
