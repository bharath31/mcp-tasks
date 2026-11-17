import type { CompletionResult } from "../../../shopping-merchant/src/types.js";
import { orderExecuteActor, browserShoppingActor } from "./actor.js";
import { browserSessionId } from "./approval.js";
import type { ShoppingLiveEnv } from "./env.js";
import { merchantLedgerRpc } from "./merchant-client.js";
import type { AuthenticatedCustomer } from "./session.js";

export type ClientOrderResult = {
  status: "completed" | "processing" | "denied" | "approval_required";
  orderId?: string;
  message?: string;
};

/**
 * Order execution stays fail-closed until operator explicitly enables Guardian-backed execution.
 *
 * Enable `SHOPPING_GUARDIAN_EXECUTE_ENABLED` only after live Guardian transaction display and
 * Auth0 CIBA approval proof are verified in the target tenant. This worker slice has no live
 * Guardian validation yet.
 */
export function guardianOrderExecutionEnabled(env: ShoppingLiveEnv): boolean {
  const flag = env.SHOPPING_GUARDIAN_EXECUTE_ENABLED?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

function mapCompletion(result: CompletionResult): ClientOrderResult {
  switch (result.status) {
    case "completed":
      return {
        status: "completed",
        orderId: result.order.id,
        message: `Order ${result.order.id} completed.`,
      };
    case "processing":
      return {
        status: "processing",
        message: "Order is processing on the merchant ledger.",
      };
    case "denied":
      return { status: "denied", message: "Order was denied by the merchant." };
    case "customer_verification_required":
      return {
        status: "approval_required",
        message: "Guardian approval must be recorded before checkout.",
      };
    default:
      throw new Error(`order_status_${result.status}`);
  }
}

export async function executeCustomerOrder(
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
  quoteId: string,
): Promise<ClientOrderResult> {
  const trimmed = quoteId.trim();
  if (!trimmed) throw new Error("invalid_quote");

  const browserSession = await browserSessionId(env, customer.customerId);
  const readActor = browserShoppingActor(
    env,
    customer.customerId,
    browserSession,
  );
  const quoteRes = await merchantLedgerRpc(env, customer.customerId, {
    op: "getQuote",
    actor: readActor,
    quoteId: trimmed,
  });
  if (!quoteRes.ok) {
    const err = (await quoteRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "quote_unavailable");
  }
  const quote = (await quoteRes.json()) as { id: string };
  if (quote.id !== trimmed) throw new Error("quote_mismatch");

  const execActor = orderExecuteActor(env, customer.customerId, browserSession);
  const execRes = await merchantLedgerRpc(env, customer.customerId, {
    op: "executeQuote",
    actor: execActor,
    quoteId: trimmed,
  });
  if (!execRes.ok) {
    const err = (await execRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "order_execute_failed");
  }
  const result = (await execRes.json()) as CompletionResult;
  if (result.status === "customer_verification_required") {
    throw new Error("order_approval_required");
  }
  return mapCompletion(result);
}
