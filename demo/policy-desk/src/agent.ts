// The refund agent: a real LLM (Workers AI) that decides which MCP tools to call. It is an
// ordinary MCP client of this Worker's own /mcp endpoint, authenticated as the agent's Auth0
// M2M client, so every refund it attempts is decided by Task Authority at the resource
// server. The model chooses what to ask for; it never chooses what is allowed.
import { z } from "zod";
import { clientToken } from "./auth0.js";
import type { Host, Sandbox } from "./host.js";
import { PROTOCOL_VERSION } from "./mcp.js";
import { SANDBOX_HEADER } from "./refunds.js";
import { recordModelCall } from "./usage.js";

// Free-plan model with multi-turn tool calling; override with the AGENT_MODEL var.
export const DEFAULT_AGENT_MODEL = "@cf/zai-org/glm-4.7-flash";
const MAX_MODEL_CALLS = 8;
const MAX_TOOL_RESULT_CHARS = 6000;

type Call = (req: Request) => Promise<Response>;

const toolCall = z.object({
  id: z.string().max(100),
  type: z.literal("function").default("function"),
  function: z.object({
    name: z.string().max(64),
    arguments: z.string().max(4000),
  }),
});
/** Chat history in the OpenAI-compatible shape Workers AI accepts. The server keeps it (conversation.ts). */
export const chatMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string().min(1).max(2000) }),
  z.object({
    role: z.literal("assistant"),
    content: z.string().max(8000).nullable().default(null),
    tool_calls: z.array(toolCall).max(8).optional(),
  }),
  z.object({
    role: z.literal("tool"),
    tool_call_id: z.string().max(100),
    content: z.string().max(MAX_TOOL_RESULT_CHARS + 100),
  }),
]);
export type ChatMessage = z.infer<typeof chatMessage>;
/** One new message from the visitor; the server adds it to the stored conversation. */
export const agentRequest = z
  .object({ message: z.string().trim().min(1).max(2000) })
  .strict();
/** Longest history the model is given, in messages and in JSON characters. */
export const MAX_HISTORY_MESSAGES = 60;
export const MAX_HISTORY_CHARS = 64_000;

/** One MCP exchange as it went over the wire, for the transcript. */
export type McpExchange = {
  request: { method: string; params: Record<string, unknown> };
  status: number;
  response: unknown;
};
export type TraceStep =
  | { kind: "model"; text: string | null; toolCalls: string[]; ms?: number }
  | {
      kind: "tool";
      callId: string;
      tool: string;
      arguments: unknown;
      exchanges: McpExchange[];
      isError: boolean;
      ms?: number;
      task?: {
        taskId: string;
        status: string;
        statusMessage?: string;
        decision?: Record<string, unknown>;
      };
    };

/** Live progress of one turn, streamed to the browser as NDJSON while the agent works. */
export type AgentEvent =
  | { type: "model_start"; n: number }
  | { type: "model_done"; n: number; step: TraceStep }
  | { type: "tool_start"; callId: string; tool: string; arguments: unknown }
  | { type: "tool_done"; step: TraceStep };

export class AgentUnavailable extends Error {
  constructor(
    readonly code: "agent_not_configured" | "model_unavailable",
    message: string,
  ) {
    super(message);
  }
}

const SYSTEM = (today: string) =>
  `You are the refund agent for an online store, working in a customer-support team. You act only through the tools you are given; they reach the store's systems over MCP.

How to work:
- Find the order first with list_orders or get_order. Never invent an order id; match the customer or item the user names. If several orders match, ask which one.
- Amounts are in cents (USD): $40.00 is 4000. Never refund more than the order's refundableMinor.
- To refund, call request_refund once per refund the user asked for, with a short honest reason. It returns a task decided by the store's approval policy (Task Authority), not by you.
- Report the task outcome plainly: "completed" means the refund was issued; "working" with a reviewer link means a person must approve it in Reviews before money moves; "failed" means it was refused, so give the reason; "cancelled" means it was withdrawn before any money moved.
- When the user asks you to check on a refund, call get_task with its taskId. Never call request_refund again for a refund that is already waiting.
- Never split a refund into smaller ones, change the amount, or retry to get around a policy decision. You cannot approve anything yourself.
- Keep replies short: one to three sentences, plain text, amounts in dollars.
Today is ${today}.`;

const GET_TASK = {
  type: "function",
  function: {
    name: "get_task",
    description:
      "Read the current state of a refund task you started (MCP tasks/get). Once a reviewer approved it, this also lets the refund run.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
} as const;

/** MCP client for this Worker's own /mcp, as the agent's Auth0 machine identity. */
function mcpClient(host: Host, s: Sandbox, call: Call) {
  return async (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<McpExchange> => {
    const token = await clientToken(host.env, host.deps, "agent");
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        },
      },
    };
    const res = await call(
      new Request(`${host.origin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "mcp-protocol-version": PROTOCOL_VERSION,
          [SANDBOX_HEADER]: s.id,
          "idempotency-key": `agent:${crypto.randomUUID()}`,
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    let response: unknown = text;
    try {
      response = JSON.parse(text);
    } catch {
      /* keep the raw text */
    }
    return { request: { method, params }, status: res.status, response };
  };
}

/** Normalizes both Workers AI output shapes (OpenAI-style `choices` and legacy `response`). */
export function parseModelOutput(out: any): {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
} {
  const msg = out?.choices?.[0]?.message;
  const rawCalls: any[] = msg?.tool_calls ?? out?.tool_calls ?? [];
  const toolCalls = rawCalls
    .map((c, i) => {
      const name = c?.function?.name ?? c?.name;
      const args = c?.function?.arguments ?? c?.arguments ?? {};
      return typeof name === "string"
        ? {
            id: String(c?.id ?? `call_${i}_${crypto.randomUUID().slice(0, 8)}`),
            name,
            arguments: typeof args === "string" ? args : JSON.stringify(args),
          }
        : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  const content = msg?.content ?? out?.response ?? null;
  return {
    content: typeof content === "string" && content.trim() ? content : null,
    toolCalls,
  };
}

const clip = (v: unknown) => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > MAX_TOOL_RESULT_CHARS
    ? `${t.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)`
    : t;
};

const resultOf = (x: McpExchange): any =>
  (x.response as any)?.result ?? (x.response as any)?.error ?? x.response;

const APPROVAL_DECISION_META = "task-authority/decision";
const APPROVAL_LINK_REASON = "auth0_passkey_approval";
const MODEL_APPROVAL_STATUS =
  "Waiting for a finance reviewer to confirm with a passkey. Use the Review this refund button above to open the request.";

/** Copy an Auth0 approval result for the model without handing it the signed link. */
export function modelFacingToolResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, any>;
  const meta = result._meta;
  const decision = meta?.[APPROVAL_DECISION_META];
  if (decision?.reasonCode !== APPROVAL_LINK_REASON) return value;

  const modelDecision = { ...decision };
  delete modelDecision.reviewUrl;
  // Only a waiting task carries the link; finished tasks keep their real outcome.
  return {
    ...result,
    ...(result.status === "working"
      ? { statusMessage: MODEL_APPROVAL_STATUS }
      : {}),
    _meta: { ...meta, [APPROVAL_DECISION_META]: modelDecision },
  };
}

/** Strip links from previously stored Auth0 approval task messages before re-sending history. */
export function modelFacingHistory(history: ChatMessage[]): ChatMessage[] {
  return history.map((message) => {
    if (message.role !== "tool") return message;
    try {
      const parsed: unknown = JSON.parse(message.content);
      const safe = modelFacingToolResult(parsed);
      return safe === parsed ? message : { ...message, content: clip(safe) };
    } catch {
      return message;
    }
  });
}

export async function runAgent(
  host: Host,
  s: Sandbox,
  call: Call,
  history: ChatMessage[],
  emit: (e: AgentEvent) => void = () => {},
) {
  const ai = host.env.AI;
  if (!ai)
    throw new AgentUnavailable(
      "agent_not_configured",
      "The agent's model is not configured on this server (no Workers AI binding).",
    );
  const model = host.env.AGENT_MODEL || DEFAULT_AGENT_MODEL;
  const mcp = mcpClient(host, s, call);

  const listed = await mcp("tools/list");
  const mcpTools = ((resultOf(listed)?.tools ?? []) as any[]).map((t) => ({
    type: "function",
    function: {
      name: String(t.name),
      description: String(t.description ?? ""),
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
  const tools = [...mcpTools, GET_TASK];
  const known = new Set(tools.map((t) => t.function.name));

  const messages: ChatMessage[] = modelFacingHistory(history);
  const added: ChatMessage[] = [];
  const trace: TraceStep[] = [];
  const push = (m: ChatMessage) => {
    messages.push(m);
    added.push(m);
  };
  let usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
  let reply: string | null = null;

  for (let i = 0; i < MAX_MODEL_CALLS; i++) {
    let out: any;
    const startedAt = host.now();
    emit({ type: "model_start", n: i + 1 });
    try {
      out = await ai.run(model, {
        messages: [
          {
            role: "system",
            content: SYSTEM(new Date(host.now()).toISOString().slice(0, 10)),
          },
          ...messages,
        ],
        tools,
        temperature: 0.2,
        max_completion_tokens: 1500,
      });
    } catch (e) {
      await recordModelCall(host, s.id, {
        model,
        durationMs: host.now() - startedAt,
        ok: false,
      });
      console.error(
        JSON.stringify({
          event: "agent_model_failed",
          model,
          message: e instanceof Error ? e.message : String(e),
        }),
      );
      throw new AgentUnavailable(
        "model_unavailable",
        "The agent's model did not answer. Try again in a moment.",
      );
    }
    const modelMs = host.now() - startedAt;
    host.conn.timings.modelCalls++;
    host.conn.timings.modelMs += modelMs;
    const inputTokens = Number(out?.usage?.prompt_tokens ?? 0);
    const outputTokens = Number(out?.usage?.completion_tokens ?? 0);
    await recordModelCall(host, s.id, {
      model,
      inputTokens,
      outputTokens,
      durationMs: modelMs,
    });
    usage = {
      inputTokens: usage.inputTokens + inputTokens,
      outputTokens: usage.outputTokens + outputTokens,
      modelCalls: usage.modelCalls + 1,
    };
    const { content, toolCalls } = parseModelOutput(out);
    const modelStep: TraceStep = {
      kind: "model",
      text: content,
      toolCalls: toolCalls.map((c) => c.name),
      ms: modelMs,
    };
    trace.push(modelStep);
    emit({ type: "model_done", n: i + 1, step: modelStep });
    push({
      role: "assistant",
      content,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.arguments },
            })),
          }
        : {}),
    });
    if (!toolCalls.length) {
      reply = content;
      break;
    }
    for (const c of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(c.arguments || "{}");
        if (parsed && typeof parsed === "object") args = parsed;
      } catch {
        /* the server rejects malformed arguments and the model sees why */
      }
      const step: Extract<TraceStep, { kind: "tool" }> = {
        kind: "tool",
        callId: c.id,
        tool: c.name,
        arguments: args,
        exchanges: [],
        isError: false,
      };
      trace.push(step);
      emit({ type: "tool_start", callId: c.id, tool: c.name, arguments: args });
      const toolStarted = host.now();
      let forModel: unknown;
      if (!known.has(c.name)) {
        step.isError = true;
        forModel = { error: `Unknown tool ${c.name}` };
      } else if (c.name === "get_task") {
        const x = await mcp("tasks/get", { taskId: String(args.taskId ?? "") });
        step.exchanges.push(x);
        forModel = resultOf(x);
      } else {
        const x = await mcp("tools/call", { name: c.name, arguments: args });
        step.exchanges.push(x);
        const r = resultOf(x);
        if (r?.resultType === "task" && typeof r.taskId === "string") {
          // A tasks requester reads the task it was handed; the model sees the full state.
          const g = await mcp("tasks/get", { taskId: r.taskId });
          step.exchanges.push(g);
          forModel = resultOf(g);
        } else forModel = r?.structuredContent ?? r;
      }
      const f = forModel as any;
      if (f?.taskId && f?.status)
        step.task = {
          taskId: f.taskId,
          status: f.status,
          statusMessage: f.statusMessage,
          decision: f._meta?.["task-authority/decision"],
        };
      step.isError =
        step.isError ||
        f?.isError === true ||
        f?.status === "failed" ||
        (typeof f?.code === "number" && typeof f?.message === "string");
      step.ms = host.now() - toolStarted;
      emit({ type: "tool_done", step });
      push({
        role: "tool",
        tool_call_id: c.id,
        content: clip(modelFacingToolResult(forModel)),
      });
    }
  }

  if (reply === null) {
    reply =
      "I stopped before finishing. Ask me again, or check the operations list.";
    push({ role: "assistant", content: reply });
  }
  return {
    model,
    reply,
    messages: added,
    trace,
    usage,
  };
}
