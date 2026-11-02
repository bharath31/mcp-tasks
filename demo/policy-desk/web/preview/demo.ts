// Local preview only: the scripted "demo" scene the link-preview clip is recorded from
// (web/og/render.mjs). The console code is the real one; only the Api answers are scripted,
// shaped exactly like the hosted sandbox's: the agent registers a $139 refund, policy holds it
// for an Auth0 passkey approval, and after ?step=done the same refund shows as executed.
import type {
  AgentEvent,
  AgentToolStep,
  Api,
  ChatTurn,
  Operation,
} from "../src/types";

const q = new URLSearchParams(location.search);
const DONE = q.get("step") === "done";
/** The signed approval link the recorder minted with the real SDK (?r=…). */
const REVIEW = `${location.origin}/approve?r=${encodeURIComponent(q.get("r") ?? "preview")}`;
const ASK = "Mei Tanaka's keyboard was dead on arrival. Refund it in full.";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (agoSec: number) =>
  new Date(Date.now() - agoSec * 1000).toISOString();

function call(
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  task?: AgentToolStep["task"],
): AgentToolStep {
  return {
    kind: "tool",
    callId,
    tool,
    arguments: args,
    isError: false,
    ms: 410,
    ...(task ? { task } : {}),
    exchanges: [
      {
        request: {
          method: "tools/call",
          params: { name: tool, arguments: args },
        },
        status: 200,
        response: { jsonrpc: "2.0", id: 1, result: task ? { task } : {} },
      },
    ],
  };
}

const order = call("d1", "get_order", { orderId: "ORD-1042" });
const refund = (done: boolean) =>
  call(
    "d2",
    "request_refund",
    { orderId: "ORD-1042", amountMinor: 13900, currency: "USD" },
    done
      ? { taskId: "op_7f3a91", status: "completed" }
      : {
          taskId: "op_7f3a91",
          status: "working",
          statusMessage: "Waiting for approval",
          decision: {
            decision: "approval_required",
            reasonCode: "auth0_passkey_approval",
            tier: "routine",
            ruleIds: ["over-auto-limit"],
            policyVersion: "refunds.v1",
            reviewUrl: REVIEW,
          },
        },
  );
const reply = (done: boolean): ChatTurn => ({
  role: "agent",
  text: done
    ? "Approved with a passkey, so I finished it: $139.00 refunded to Mei Tanaka for order ORD-1042."
    : "Mei's order ORD-1042 is $139.00. That is above what I may refund alone, so policy is holding it for a person. A finance reviewer must approve it with a passkey; I will finish once they do.",
  steps: [order, refund(done)],
  ms: 3480,
});

const op = (state: Operation["state"]): Operation => ({
  id: "op_7f3a91",
  state,
  action: "refund:create",
  resource: "payment:ORD-1042",
  amountMinor: 13900,
  currency: "USD",
  customer: "Mei Tanaka",
  item: "Mechanical keyboard",
  reason: "Dead on arrival",
  requester: "Refund agent (for Alex)",
  tier: "routine",
  ruleIds: ["over-auto-limit"],
  decision: "approval_required",
  policyVersion: "refunds.v1",
  createdAt: iso(40),
});
const earlier: Operation = {
  ...op("executed"),
  id: "op_2b8d40",
  resource: "payment:ORD-1031",
  amountMinor: 4000,
  customer: "Dana Whitfield",
  item: "Trail jacket",
  ruleIds: ["auto-allow"],
  decision: "allow",
  createdAt: iso(300),
};

export function demoApi(base: Api): Api {
  let asked = DONE;
  const turns: ChatTurn[] = DONE
    ? [{ role: "user", text: ASK }, reply(true)]
    : [];
  return {
    ...base,
    conversation: async () => structuredClone(turns),
    queue: async () => [],
    state: async () => ({
      operations: asked
        ? [op(DONE ? "executed" : "pending_approval"), earlier]
        : [earlier],
      budget: {
        usedMinor: DONE ? 17900 : 4000,
        maxMinor: 50000,
        usedCount: DONE ? 2 : 1,
        maxCount: 20,
      },
    }),
    progress: async () => ({
      signedIn: true,
      policyPublished: true,
      autoAllowedRefund: true,
      approvalRequestedRefund: true,
      approvedWithStepUp: true,
      eventsPresent: true,
      policyEdited: true,
    }),
    async agent(message: string, onEvent?: (e: AgentEvent) => void) {
      const t0 = performance.now();
      const model = (n: number, tools: string[], ms: number) => {
        onEvent?.({ type: "model_start", n });
        return wait(ms).then(() =>
          onEvent?.({
            type: "model_done",
            n,
            step: {
              kind: "model",
              text: tools.length ? null : "ok",
              toolCalls: tools,
              ms,
            },
          }),
        );
      };
      const tool = async (s: AgentToolStep) => {
        onEvent?.({
          type: "tool_start",
          callId: s.callId,
          tool: s.tool,
          arguments: s.arguments,
        });
        await wait(s.ms ?? 400);
        onEvent?.({ type: "tool_done", step: s });
      };
      await model(1, ["get_order"], 700);
      await tool(order);
      await model(2, ["request_refund"], 650);
      await tool(refund(false));
      await model(3, [], 600);
      asked = true;
      const mine: ChatTurn = { role: "user", text: message };
      const theirs = { ...reply(false), ms: performance.now() - t0 };
      turns.push(mine, theirs);
      return {
        model: "@cf/zai-org/glm-4.7-flash",
        reply: theirs.text,
        messages: [],
        trace: [order, refund(false)],
        turns: [mine, theirs],
        usage: { inputTokens: 1, outputTokens: 1, modelCalls: 3 },
      };
    },
  };
}
