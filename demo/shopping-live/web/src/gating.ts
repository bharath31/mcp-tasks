import type { ApprovalRecord, Cart, Quote, SessionResponse } from "./types.js";

export type GateReason =
  | "ok"
  | "no_session"
  | "unauthenticated"
  | "agent_unavailable"
  | "guardian_unavailable"
  | "order_execute_unavailable"
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
  if (session.capabilities?.agentRuns !== true) return "agent_unavailable";
  return "ok";
}

export function canRequestQuote(
  session: SessionResponse | null,
  cart: Cart | null,
): GateReason {
  if (!session) return "no_session";
  if (!sessionVerified(session)) return "unauthenticated";
  if (!cart) return "no_cart";
  if (!cart.items.length) return "empty_cart";
  return "ok";
}

export function canStartApproval(
  session: SessionResponse | null,
  quote: Quote | null,
): GateReason {
  if (!session) return "no_session";
  if (!sessionVerified(session)) return "unauthenticated";
  if (!quote) return "no_quote";
  if (!quote.verified) return "quote_unverified";
  if (session.capabilities?.guardianApproval !== true) {
    return "guardian_unavailable";
  }
  return "ok";
}

export function canExecuteOrder(
  session: SessionResponse | null,
  quote: Quote | null,
  approval: ApprovalRecord | null,
): GateReason {
  const gate = canStartApproval(session, quote);
  if (gate !== "ok") return gate;
  if (!session) return "no_session";
  if (!approval) return "no_approval";
  if (approval.status === "pending") return "approval_pending";
  if (
    approval.status === "denied" ||
    approval.status === "expired" ||
    approval.status === "failed"
  )
    return "approval_denied";
  if (session.capabilities?.orderExecute !== true) {
    return "order_execute_unavailable";
  }
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
    case "agent_unavailable":
      return "Agent runs need Workers AI, Browser Run, and a configured MERCHANT_ORIGIN on this deployment.";
    case "guardian_unavailable":
      return "Guardian CIBA approval is not configured on this deployment.";
    case "order_execute_unavailable":
      return "Order execution stays disabled until the operator enables live Guardian checkout.";
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
