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
  capabilities: {
    agentRuns: true,
    guardianApproval: true,
    orderExecute: true,
  },
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
  destination: {
    id: "addr_1",
    label: "Home",
    detailsJson: '{"country":"US"}',
  },
};

const pending: ApprovalRecord = {
  id: "a1",
  quoteId: "q1",
  status: "pending",
  delivery: "guardian_push",
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

test("capability flags gate agent, approval, and execute", () => {
  const noAgent: SessionResponse = {
    ...authed,
    capabilities: {
      agentRuns: false,
      guardianApproval: true,
      orderExecute: true,
    },
  };
  const noGuardian: SessionResponse = {
    ...authed,
    capabilities: {
      agentRuns: true,
      guardianApproval: false,
      orderExecute: true,
    },
  };
  assert.equal(canStartAgent(noAgent), "agent_unavailable");
  assert.equal(canRequestQuote(noAgent, cart), "ok");
  assert.equal(canStartApproval(noAgent, quote), "ok");
  assert.equal(canStartApproval(noGuardian, quote), "guardian_unavailable");
  assert.equal(
    canExecuteOrder(noGuardian, quote, approved),
    "guardian_unavailable",
    "execute checks approval path first",
  );
  assert.equal(
    canExecuteOrder(
      { ...authed, capabilities: { ...authed.capabilities!, orderExecute: false } },
      quote,
      approved,
    ),
    "order_execute_unavailable",
  );
});
