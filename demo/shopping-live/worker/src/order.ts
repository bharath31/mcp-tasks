import type { ShoppingLiveEnv } from "./env.js";
import type { AuthenticatedCustomer } from "./session.js";

/**
 * Order execution stays fail-closed until operator explicitly enables Guardian-backed execution.
 */
export function guardianOrderExecutionEnabled(env: ShoppingLiveEnv): boolean {
  const flag = env.SHOPPING_GUARDIAN_EXECUTE_ENABLED?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export async function executeCustomerOrder(
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
  quoteId: string,
): Promise<never> {
  void env;
  void customer;
  void quoteId;
  throw new Error("order_execute_unavailable");
}