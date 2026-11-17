import { customerStateRpc, customerStateStub } from "./customer-state-do.js";
import type { ShoppingLiveEnv } from "./env.js";

const QUOTE_POINTER_KEY = "nominee:active_quote_id";
const CHALLENGE_POINTER_KEY = "nominee:active_challenge_id";
const AGENT_RUN_POINTER_KEY = "nominee:active_agent_run_id";

export type CheckoutPointers = {
  quoteId: string | null;
  challengeId: string | null;
  agentRunId: string | null;
};

type CheckoutSessionRpc =
  | { op: "setActiveQuoteId"; quoteId: string | null }
  | { op: "setActiveChallengeId"; challengeId: string | null }
  | { op: "setActiveAgentRunId"; agentRunId: string | null }
  | { op: "getCheckoutPointers" }
  | { op: "clearCheckoutPointers" };

async function checkoutSessionRpc(
  stub: DurableObjectStub,
  customerId: string,
  body: CheckoutSessionRpc,
): Promise<Response> {
  return stub.fetch("http://customer-state/internal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nominee-customer-id": customerId,
    },
    body: JSON.stringify(body),
  });
}

async function pointerOp(
  env: ShoppingLiveEnv,
  customerId: string,
  body: CheckoutSessionRpc,
): Promise<void> {
  const stub = customerStateStub(env, customerId);
  const res = await checkoutSessionRpc(stub, customerId, body);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "checkout_pointer_failed");
  }
}

export async function setActiveQuoteId(
  env: ShoppingLiveEnv,
  customerId: string,
  quoteId: string | null,
): Promise<void> {
  await pointerOp(env, customerId, { op: "setActiveQuoteId", quoteId });
}

export async function setActiveChallengeId(
  env: ShoppingLiveEnv,
  customerId: string,
  challengeId: string | null,
): Promise<void> {
  await pointerOp(env, customerId, {
    op: "setActiveChallengeId",
    challengeId,
  });
}

export async function setActiveAgentRunId(
  env: ShoppingLiveEnv,
  customerId: string,
  agentRunId: string | null,
): Promise<void> {
  await pointerOp(env, customerId, { op: "setActiveAgentRunId", agentRunId });
}

export async function readCheckoutPointers(
  env: ShoppingLiveEnv,
  customerId: string,
): Promise<CheckoutPointers> {
  const stub = customerStateStub(env, customerId);
  const res = await checkoutSessionRpc(stub, customerId, {
    op: "getCheckoutPointers",
  });
  if (!res.ok) {
    return { quoteId: null, challengeId: null, agentRunId: null };
  }
  return (await res.json()) as CheckoutPointers;
}

export async function clearCheckoutPointers(
  env: ShoppingLiveEnv,
  customerId: string,
): Promise<void> {
  await pointerOp(env, customerId, { op: "clearCheckoutPointers" });
}

export const CHECKOUT_STORAGE_KEYS = {
  QUOTE_POINTER_KEY,
  CHALLENGE_POINTER_KEY,
  AGENT_RUN_POINTER_KEY,
} as const;
