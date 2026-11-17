import type { ApprovalRecord, Cart, Quote, SessionResponse } from "./types.js";

export type GateReason =
  | "ok"
  | "no_session"
  | "unauthenticated"
  | "no_cart"
  | "empty_cart"
  | "no_quote"
  | "quote_unverified"
  | "no_approval"
  | "approval_pending"
  | "approval_denied";

export function sessionVerified(session: SessionResponse | null): boolean {
  return Boolean(session?.authenticated && session.customerId);
}

export function canStartAgent(session: SessionResponse | null): GateReason {
  if (!session) return "no_session";
  if (!sessionVerified(session)) return "unauthenticated";
  return "ok";
}

export function canRequestQuote(
  session: SessionResponse | null,
  cart: Cart | null,
): GateReason {
  const gate = canStartAgent(session);
  if (gate !== "ok") return gate;
  if (!cart) return "no_cart";
  if (!cart.items.length) return "empty_cart";
  return "ok";
}

export function canStartApproval(
  session: SessionResponse | null,
  quote: Quote | null,
): GateReason {
  const gate = canStartAgent(session);
  if (gate !== "ok") return gate;
  if (!quote) return "no_quote";
  if (!quote.verified) return "quote_unverified";
  return "ok";
}

export function canExecuteOrder(
  session: SessionResponse | null,
  quote: Quote | null,
  approval: ApprovalRecord | null,
): GateReason {
  const gate = canStartApproval(session, quote);
  if (gate !== "ok") return gate;
  if (!approval) return "no_approval";
  if (approval.status === "pending") return "approval_pending";
  if (
    approval.status === "denied" ||
    approval.status === "expired" ||
    approval.status === "failed"
  )
    return "approval_denied";
  return "ok";
}

export function gateLabel(reason: GateReason): string {
  switch (reason) {
    case "ok":
      return "";
    case "no_session":
      return "Connect the Nominee shopping API to continue.";
    case "unauthenticated":
      return "Sign in with the merchant account before shopping or checkout.";
    case "no_cart":
      return "Cart data is not available yet.";
    case "empty_cart":
      return "The cart is empty. Add items in the merchant browser first.";
    case "no_quote":
      return "Request a server-verified quote before Guardian approval.";
    case "quote_unverified":
      return "This quote has not been verified by the merchant service.";
    case "no_approval":
      return "Start Guardian approval after you have a verified quote.";
    case "approval_pending":
      return "Complete Guardian approval before executing the order.";
    case "approval_denied":
      return "Guardian approval was denied or expired.";
  }
}
