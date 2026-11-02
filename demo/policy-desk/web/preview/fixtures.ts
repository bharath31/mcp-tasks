// Local visual preview only: an in-memory Api with believable sandbox data, so the console can be
// rendered and screenshotted without Auth0 or the Worker. Never bundled into the real site.
import type {
  AgentEvent,
  AgentToolStep,
  Api,
  ApprovalItem,
  AuditEvent,
  ChatTurn,
  Operation,
  PolicyView,
} from "../src/types";

export const PENDING_KEY = "policy-desk.pending-decision";

const now = Date.now();
const iso = (agoSec: number) => new Date(now - agoSec * 1000).toISOString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Network latency, so loading states and layout shifts show up in the preview. */
const LAT = Number(new URLSearchParams(location.search).get("lat") ?? 250);
const SCENE = new URLSearchParams(location.search).get("scene") ?? "busy";

const ops: Operation[] = [
  {
    id: "op_7f3a91",
    state: "pending_approval",
    action: "refund:create",
    resource: "order:ORD-1042",
    amountMinor: 13900,
    currency: "USD",
    customer: "Mei Tanaka",
    item: "Mechanical keyboard",
    reason: "Dead on arrival",
    requester: "Refund agent (for Alex)",
    tier: "routine",
    assurance: "session_mfa",
    ruleIds: ["over-auto-limit"],
    decision: "approval_required",
    policyVersion: "refunds.v1",
    createdAt: iso(42),
    digest:
      "sha256:4f1c9a0e7d2b88a1c3e5f7a9b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8",
    approvalId: "apr_51c2",
  },
  {
    id: "op_2b8d40",
    state: "executed",
    action: "refund:create",
    resource: "order:ORD-1031",
    amountMinor: 4000,
    currency: "USD",
    customer: "Dana Whitfield",
    item: "Trail jacket",
    reason: "Torn sleeve",
    requester: "Refund agent (for Alex)",
    ruleIds: ["auto-allow"],
    decision: "allow",
    policyVersion: "refunds.v1",
    createdAt: iso(260),
  },
];

const turns: ChatTurn[] =
  SCENE === "empty"
    ? []
    : [
        {
          role: "user",
          text: "Dana Whitfield's trail jacket arrived with a torn sleeve. Refund her $40.",
        },
        {
          role: "agent",
          text: "Done. I refunded $40.00 to Dana Whitfield for order ORD-1031. Policy allowed it inside my daily budget, so no person was needed.",
          steps: [
            step("call_1", "get_order", { orderId: "ORD-1031" }),
            step(
              "call_2",
              "request_refund",
              { orderId: "ORD-1031", amountMinor: 4000 },
              { taskId: "op_2b8d40", status: "completed" },
            ),
          ],
          ms: 3120,
        },
        {
          role: "user",
          text: "Mei Tanaka's keyboard was dead on arrival. Refund it in full.",
        },
        {
          role: "agent",
          text: "Mei's order ORD-1042 is $139.00. That is above what I may refund alone, so policy is holding it for a person. A reviewer must approve it; I will finish once they do.",
          steps: [
            step("call_3", "get_order", { orderId: "ORD-1042" }),
            step(
              "call_4",
              "request_refund",
              { orderId: "ORD-1042", amountMinor: 13900 },
              {
                taskId: "op_7f3a91",
                status: "working",
                statusMessage: "Waiting for approval",
                decision: {
                  decision: "approval_required",
                  tier: "routine",
                  ruleIds: ["over-auto-limit"],
                  policyVersion: "refunds.v1",
                },
              },
            ),
          ],
          ms: 4480,
        },
      ];

function step(
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
    ms: 380,
    ...(task ? { task } : {}),
    exchanges: [
      {
        request: {
          method: "tools/call",
          params: { name: tool, arguments: args },
        },
        status: 200,
        response: task
          ? {
              jsonrpc: "2.0",
              id: 1,
              result: { task: { taskId: task.taskId, status: task.status } },
            }
          : {
              jsonrpc: "2.0",
              id: 1,
              result: {
                content: [
                  {
                    type: "text",
                    text: '{"orderId":"ORD","totalMinor":13900}',
                  },
                ],
              },
            },
      },
    ],
  };
}

const queue: ApprovalItem[] = ops
  .filter((o) => o.state === "pending_approval")
  .map((o) => ({
    id: o.approvalId!,
    operation: o,
    tier: o.tier!,
    digest: o.digest!,
    assurance: "session_mfa",
    appCodeAccepted: false,
  }));

const audit: AuditEvent[] = [
  {
    at: iso(260),
    type: "operation.registered",
    actorChain: ["alex@policy-desk", "refund-agent"],
    policyVersion: "refunds.v1",
    ruleIds: ["auto-allow"],
    detail: "refund:create on order:ORD-1031",
  },
  {
    at: iso(259),
    type: "decision.allow",
    actorChain: ["task-authority"],
    policyVersion: "refunds.v1",
    ruleIds: ["auto-allow"],
  },
  {
    at: iso(258),
    type: "operation.executed",
    actorChain: ["refund-agent"],
    detail: "Simulated payment pi_sim_2b8d",
  },
];

const policy: PolicyView = {
  resourceServer: "https://refunds.policy-desk.example/api",
  version: "refunds.v1",
  settings: {
    agentAutoLimitMinor: 5000,
    budgetMaxMinor: 50000,
    budgetMaxCount: 20,
    highValueAboveMinor: 100000,
    allowAuthenticatorApp: false,
  },
  summary: [
    {
      id: "auto-allow",
      when: "args.amountMinor <= 5000 && budget.remainingMinor >= args.amountMinor",
      text: "The agent may refund up to $50.00 alone while its daily budget lasts.",
    },
    {
      id: "over-auto-limit",
      tier: "routine",
      when: "args.amountMinor > 5000",
      text: "Above $50.00 a reviewer approves, with a recent multi-factor sign-in.",
    },
    {
      id: "high-value",
      tier: "high_value",
      when: "args.amountMinor > 100000",
      text: "Above $1,000.00 each approval needs its own fresh passkey check.",
    },
    {
      id: "self-approval",
      when: "actor.sub == requester.sub",
      text: "Nobody approves their own request.",
    },
  ],
  envelope: {
    agentAutoLimitMinor: [0, 50000],
    budgetMaxMinor: [0, 200000],
    budgetMaxCount: [0, 100],
    highValueAboveMinor: [10000, 500000],
  },
  publishes: { used: 1, max: 10 },
  document: { id: "refunds", version: "refunds.v1", rules: ["…"] },
};

export async function getApi(): Promise<Api> {
  const later = async <T>(v: T, ms = LAT): Promise<T> => {
    await wait(ms);
    return structuredClone(v);
  };
  return {
    me: () =>
      later({
        sub: "auth0|reviewer",
        name: "Bat",
        email: "bat@example.com",
        sandboxId: "sbx_preview",
        initialized: SCENE !== "new",
        token: { amr: ["email"], dpopBound: true },
      }),
    info: () =>
      later({
        limits: {
          maxPending: 10,
          sandboxTtlMinutes: 15,
          maxPolicyPublishesPerHour: 10,
          sandboxExpiresAt: new Date(now + 11 * 60e3).toISOString(),
        },
        agent: {
          name: "Refund agent",
          subject: "agent@clients",
          model: "@cf/zai-org/glm-4.7-flash",
          available: true,
        },
        resourceServer: policy.resourceServer,
      }),
    async agent(message: string, onEvent?: (e: AgentEvent) => void) {
      const t0 = performance.now();
      onEvent?.({ type: "model_start", n: 1 });
      await wait(900);
      onEvent?.({
        type: "model_done",
        n: 1,
        step: { kind: "model", text: null, toolCalls: ["get_order"], ms: 900 },
      });
      onEvent?.({
        type: "tool_start",
        callId: "x1",
        tool: "get_order",
        arguments: { orderId: "ORD-1050" },
      });
      await wait(500);
      const s = step("x1", "get_order", { orderId: "ORD-1050" });
      onEvent?.({ type: "tool_done", step: s });
      onEvent?.({ type: "model_start", n: 2 });
      await wait(900);
      onEvent?.({
        type: "model_done",
        n: 2,
        step: { kind: "model", text: "ok", toolCalls: [], ms: 900 },
      });
      const reply: ChatTurn = {
        role: "agent",
        text: `I looked at that order. ${message.length > 60 ? "It needs a person to approve it." : "Done."}`,
        steps: [s],
        ms: performance.now() - t0,
      };
      const mine: ChatTurn = { role: "user", text: message };
      turns.push(mine, reply);
      return {
        model: "@cf/zai-org/glm-4.7-flash",
        reply: "",
        messages: [],
        trace: [
          { kind: "model", text: null, toolCalls: ["get_order"], ms: 900 },
          s,
          { kind: "model", text: "ok", toolCalls: [], ms: 900 },
        ],
        turns: [mine, reply],
        usage: { inputTokens: 1, outputTokens: 1, modelCalls: 2 },
      };
    },
    conversation: () => later(turns, LAT * 2),
    clearConversation: async () => void turns.splice(0),
    agentKey: () =>
      later({
        available: true,
        connected: false,
        mcpUrl: "https://example.test/mcp",
      }),
    connectAgent: () =>
      later({
        token: "tok_preview",
        expiresAt: iso(-3600),
        mcpUrl: "https://example.test/mcp",
        claudeCode:
          "claude mcp add --transport http policy-desk https://example.test/mcp --header 'Authorization: Bearer tok_preview'",
        mcpJson: {},
      }),
    disconnectAgent: async () => {},
    state: () =>
      later({
        operations: SCENE === "empty" ? [] : ops,
        budget: {
          usedMinor: 4000,
          maxMinor: 50000,
          usedCount: 1,
          maxCount: 20,
        },
      }),
    audit: () => later(audit),
    queue: () => later(SCENE === "empty" ? [] : queue),
    prefetchQueue() {},
    lease: () => later(undefined),
    decide: () =>
      later({
        ok: true,
        status: 200,
        message: "Approved.",
        decision: "approve" as const,
      }),
    resumePending: async () => undefined,
    progress: () =>
      later({
        signedIn: true,
        policyPublished: true,
        autoAllowedRefund: SCENE !== "empty",
        approvalRequestedRefund: SCENE !== "empty",
        approvedWithStepUp: false,
        eventsPresent: true,
        policyEdited: false,
      }),
    policy: () => later(policy),
    savePolicy: () => later("refunds.v2"),
    restorePolicy: () => later("refunds.v3"),
    simulate: () =>
      later({
        considered: 2,
        changed: 1,
        rows: [
          {
            operationId: "op_7f3a91",
            summary: "$139.00 to Mei Tanaka",
            before: "approval_required",
            after: "allow",
          },
        ],
      }),
    reset: () => later(undefined),
    signOut: async () => {},
  };
}
