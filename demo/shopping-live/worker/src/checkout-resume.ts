import { agentIntegrationConfigured } from "./agent-host.js";
import { readCustomerApproval, type ApprovalRecord } from "./approval.js";
import { readCustomerQuote, type ClientQuote } from "./cart.js";
import {
  readCheckoutPointers,
  setActiveAgentRunId,
  setActiveChallengeId,
  setActiveQuoteId,
} from "./checkout-session.js";
import type { ShoppingLiveEnv } from "./env.js";
import {
  getShoppingAgentRunForPoll,
  type RunStatus,
  type ShoppingAgentOrchestrationEnv,
} from "../../../shopping-agent-orchestration/src/index.js";
import type { AuthenticatedCustomer } from "./session.js";

export type CheckoutResumeAgent = {
  id: string;
  status: RunStatus;
  goal?: string;
  events: { at: string; kind: string; message: string }[];
};

export type CheckoutResumeResponse = {
  quote: ClientQuote | null;
  approval: ApprovalRecord | null;
  agent: CheckoutResumeAgent | null;
};

function isApprovalTerminal(status: ApprovalRecord["status"]): boolean {
  return (
    status === "approved" ||
    status === "denied" ||
    status === "expired" ||
    status === "failed"
  );
}

export async function resumeCustomerCheckout(
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
): Promise<CheckoutResumeResponse> {
  const pointers = await readCheckoutPointers(env, customer.customerId);
  let quote: ClientQuote | null = null;
  let approval: ApprovalRecord | null = null;
  let agent: CheckoutResumeAgent | null = null;

  if (pointers.quoteId) {
    quote = await readCustomerQuote(env, customer, pointers.quoteId);
    if (!quote) {
      await setActiveQuoteId(env, customer.customerId, null);
      await setActiveChallengeId(env, customer.customerId, null);
    }
  }

  if (pointers.challengeId && quote) {
    try {
      approval = await readCustomerApproval(
        env,
        customer,
        pointers.challengeId,
      );
      if (approval.quoteId !== quote.id) {
        approval = null;
        await setActiveChallengeId(env, customer.customerId, null);
      } else if (isApprovalTerminal(approval.status)) {
        if (approval.status !== "approved") {
          await setActiveChallengeId(env, customer.customerId, null);
        }
      }
    } catch {
      await setActiveChallengeId(env, customer.customerId, null);
    }
  } else if (pointers.challengeId && !quote) {
    await setActiveChallengeId(env, customer.customerId, null);
  }

  if (pointers.agentRunId && agentIntegrationConfigured(env)) {
    const polled = await getShoppingAgentRunForPoll(
      {
        AGENT_RUNS: env.AGENT_RUNS!,
        AI: env.AI!,
        BROWSER: env.BROWSER!,
        MERCHANT_ORIGIN: env.MERCHANT_ORIGIN!,
        AGENT_MODEL: env.AGENT_MODEL,
        SELF_SUBFETCH: env.SELF_SUBFETCH,
      } satisfies ShoppingAgentOrchestrationEnv,
      customer.customerId,
      pointers.agentRunId,
    );
    if (
      polled &&
      polled.run.ownerId === customer.customerId &&
      polled.parentInnerSid === customer.innerSid
    ) {
      agent = {
        id: polled.run.id,
        status: polled.run.status,
        goal: polled.run.goal ?? undefined,
        events: polled.run.events.map((event) => ({
          at: new Date(event.atMs).toISOString(),
          kind: event.kind,
          message: event.message,
        })),
      };
      if (polled.run.status === "completed" || polled.run.status === "failed") {
        await setActiveAgentRunId(env, customer.customerId, null);
      }
    } else {
      await setActiveAgentRunId(env, customer.customerId, null);
    }
  }

  return { quote, approval, agent };
}
