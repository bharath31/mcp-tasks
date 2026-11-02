// Minimal typed MCP Tasks (io.modelcontextprotocol/tasks, spec 2026-07-28) receiver.
// @modelcontextprotocol/ext-tasks 0.2.2 ships requester-side support and a 2025-11-25
// receiver only, so this adapter implements the server side of the 2026-07-28 wire
// contract directly, validating shapes with that package's core/v2 schemas.
import {
  DetailedTaskV2Schema,
  CreateTaskResultV2Schema,
  TASKS_EXTENSION_ID_V2,
  UpdateTaskRequestV2Schema,
  hasTaskClientCapabilityV2,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import { z } from "zod";
import {
  renderMcp,
  stepUpChallenge,
  type OperationView,
} from "@task-authority/sdk";
import { AuthRequired, type McpAuthenticator, type Principal } from "./auth.js";
import type { Task } from "./repository.js";
import { AppError, refundInputSchema, type RefundService } from "./tasks.js";

export const PROTOCOL_VERSION = "2026-07-28";
const M = "io.modelcontextprotocol";
const META_VERSION = `${M}/protocolVersion`;
const META_CAPS = `${M}/clientCapabilities`;
const E = {
  parse: -32700,
  invalid: -32600,
  method: -32601,
  params: -32602,
  internal: -32603,
  missingCap: -32021,
  version: -32022,
} as const;

/**
 * Hosts relay only the error message to the model, so it says what is missing and what to do.
 * Claude Code, for one, declares tasks only in some sessions (not from subagents or one-shot
 * `claude -p` runs).
 */
const MISSING_TASKS =
  "Missing required client capability: io.modelcontextprotocol/tasks. This tool runs as an MCP task; call it from a client session that supports MCP tasks.";

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly http = 200,
  ) {
    super(message);
  }
}

export function taskView(t: Task) {
  const base = {
    taskId: t.taskId,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    lastUpdatedAt: t.updatedAt.toISOString(),
    ttlMs: t.retainUntil.getTime() - t.createdAt.getTime(),
    pollIntervalMs: t.pollIntervalMs,
    ...(t.statusMessage ? { statusMessage: t.statusMessage } : {}),
  };
  const out =
    t.status === "input_required"
      ? { ...base, inputRequests: t.inputRequests ?? {} }
      : t.status === "completed"
        ? {
            ...base,
            result: {
              resultType: "complete" as const,
              ...(t.result ?? { content: [], isError: false }),
            },
          }
        : t.status === "failed"
          ? {
              ...base,
              error: t.error ?? {
                code: E.internal,
                message: "execution_failed",
              },
            }
          : base;
  return DetailedTaskV2Schema.parse(out);
}

const TOOLS = [
  {
    name: "request_refund",
    title: "Request a refund",
    description:
      "Request a customer refund for a returned order. Long-running: returns a durable task. Task Authority evaluates the configured policy and may require an eligible reviewer's approval. Poll with tasks/get; it keeps running if you disconnect.",
    schema: refundInputSchema,
  },
  {
    name: "create_test_payment",
    title: "Create a test payment",
    description:
      "Create a TEST-MODE or SIMULATED paid order for the caller's organization so there is something to refund. No real money moves.",
    schema: z
      .object({
        amountMinor: z.number().int().min(100).max(1_000_000),
        currency: z.string().regex(/^[A-Z]{3}$/),
        idempotencyKey: z.uuid(),
      })
      .strict(),
  },
  {
    name: "get_payment",
    title: "Inspect a payment",
    description:
      "Read the amount, refunded amount and currency of a payment in the caller's organization.",
    schema: z.object({ paymentId: z.string().min(3).max(100) }).strict(),
  },
] as const;

export type McpDeps = {
  service: RefundService;
  authn: McpAuthenticator;
  serverName: string;
  providerMode: string;
};

const toolResult = (data: Record<string, unknown>, isError = false) => ({
  resultType: "complete" as const,
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredContent: data,
  isError,
});

export async function handleMcp(
  req: Request,
  deps: McpDeps,
): Promise<Response> {
  const json = (
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      },
    });
  let id: string | number | null = null;
  try {
    if (req.method !== "POST")
      throw new RpcError(E.invalid, "POST a JSON-RPC request.", undefined, 405);
    let msg: any;
    try {
      msg = JSON.parse(await req.text());
    } catch {
      throw new RpcError(E.parse, "Parse error", undefined, 400);
    }
    if (
      Array.isArray(msg) ||
      typeof msg !== "object" ||
      msg === null ||
      msg.jsonrpc !== "2.0" ||
      typeof msg.method !== "string"
    )
      throw new RpcError(E.invalid, "Invalid request", undefined, 400);
    id = msg.id ?? null;
    if (msg.id === undefined) return new Response(null, { status: 202 }); // notifications need no reply
    const { method } = msg;
    const params = (msg.params ?? {}) as Record<string, any>;

    // A 2025-revision client opens with initialize. Answer with the version error, so the
    // client can see which revision to speak, and say in words what will work.
    if (method === "initialize")
      throw new RpcError(
        E.version,
        `Unsupported protocol version: this server speaks MCP ${PROTOCOL_VERSION} only (per-request _meta, no initialize handshake). Use a client that supports ${PROTOCOL_VERSION}, such as Claude Code 2.1.310 or later.`,
        {
          supported: [PROTOCOL_VERSION],
          ...(typeof params.protocolVersion === "string"
            ? { requested: params.protocolVersion }
            : {}),
        },
        400,
      );
    const meta = (params._meta ?? {}) as Record<string, any>;
    const version = meta[META_VERSION];
    if (typeof version !== "string")
      throw new RpcError(
        E.invalid,
        `Missing _meta["${META_VERSION}"].`,
        { supported: [PROTOCOL_VERSION] },
        400,
      );
    if (version !== PROTOCOL_VERSION)
      throw new RpcError(
        E.version,
        "Unsupported protocol version",
        { supported: [PROTOCOL_VERSION], requested: version },
        400,
      );
    const header = req.headers.get("mcp-protocol-version");
    if (header && header !== version)
      throw new RpcError(
        E.invalid,
        "MCP-Protocol-Version header disagrees with _meta.",
        undefined,
        400,
      );

    if (method === "server/discover")
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: {
            tools: {},
            extensions: { [TASKS_EXTENSION_ID_V2]: {} },
          },
          _meta: {
            [`${M}/serverInfo`]: { name: deps.serverName, version: "2.0.0" },
          },
          instructions: `Refund Desk reference implementation (${deps.providerMode}). request_refund is long-running and returns a task. Approval by a manager is never granted through this API.`,
          ttlMs: 3_600_000,
          cacheScope: "public",
        },
      });

    let principal: Principal;
    try {
      principal = await deps.authn.authenticate(req);
    } catch (e) {
      if (e instanceof AuthRequired)
        return json(
          {
            jsonrpc: "2.0",
            id,
            error: { code: E.invalid, message: e.message },
          },
          e.code === "insufficient_context" ? 403 : 401,
          {
            "www-authenticate": deps.authn.challenge(
              e.code === "missing_token" ? undefined : e.code,
            ),
          },
        );
      throw e;
    }
    const taskCapable =
      hasTaskClientCapabilityV2(meta[META_CAPS] ?? {}) ||
      Boolean((meta[META_CAPS] as any)?.extensions?.[TASKS_EXTENSION_ID_V2]);
    const needTasks = () => {
      if (!taskCapable)
        throw new RpcError(E.missingCap, MISSING_TASKS, {
          requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID_V2]: {} } },
        });
    };
    const taskId = () => {
      const t = z.string().uuid().safeParse(params.taskId);
      if (!t.success) throw new RpcError(E.params, "Invalid taskId");
      const named = req.headers.get("mcp-name");
      if (named && named !== t.data)
        throw new RpcError(
          E.params,
          "Mcp-Name header does not match params.taskId",
          undefined,
          400,
        );
      return t.data;
    };

    switch (method) {
      case "tools/list":
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            resultType: "complete",
            tools: TOOLS.map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: z.toJSONSchema(t.schema, { io: "input" }),
            })),
            // Required on list results from 2026-07-28; the catalog is the same for every caller.
            ttlMs: 3_600_000,
            cacheScope: "public",
          },
        });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) throw new RpcError(E.params, "Unknown tool");
        const args = params.arguments ?? {};
        const svc = deps.service;
        if (tool.name === "request_refund") {
          needTasks(); // a task is only ever returned to a client that declared the extension
          try {
            const task = await svc.create(principal, args);
            const authority = task.operationId
              ? await svc.transportOutcome(task)
              : null;
            return json({
              jsonrpc: "2.0",
              id,
              result: CreateTaskResultV2Schema.parse({
                resultType: "task",
                ...taskView(task),
                ...(authority
                  ? {
                      _meta: {
                        "task-authority/decision": {
                          ...renderMcp(authority).authority,
                          operationId: authority.operation.id,
                          operationUrl: authority.operationUrl,
                          ...(authority.reviewUrl
                            ? { reviewUrl: authority.reviewUrl }
                            : {}),
                        },
                      },
                    }
                  : {}),
              }),
            });
          } catch (e) {
            if (
              e instanceof AppError &&
              e.status === 401 &&
              e.code === "insufficient_user_authentication"
            )
              return json(
                {
                  jsonrpc: "2.0",
                  id,
                  error: { code: E.invalid, message: e.code, data: e.data },
                },
                401,
                {
                  "www-authenticate": stepUpChallenge(
                    (e.data?.operation ?? {}) as OperationView,
                  ),
                },
              );
            if (e instanceof AppError && e.status !== 404)
              return json({
                jsonrpc: "2.0",
                id,
                result: toolResult({ outcome: e.code, ...e.data }, true),
              });
            throw e;
          }
        }
        const parsed = tool.schema.safeParse(args);
        if (!parsed.success)
          throw new RpcError(E.params, "Invalid tool arguments");
        const a = parsed.data as any;
        const payments = svc.o.payments;
        if (tool.name === "create_test_payment")
          return json({
            jsonrpc: "2.0",
            id,
            result: toolResult({
              paymentId: await payments.createTestPayment(
                principal.orgId,
                a.amountMinor,
                a.currency,
                a.idempotencyKey,
              ),
              providerMode: payments.mode,
            }),
          });
        const snap = await payments
          .inspect(principal.orgId, a.paymentId)
          .catch(() => null);
        return json({
          jsonrpc: "2.0",
          id,
          result: snap
            ? toolResult({ ...snap, providerMode: payments.mode })
            : toolResult({ outcome: "payment_not_found" }, true),
        });
      }
      case "tasks/get":
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            resultType: "complete",
            ...taskView(await deps.service.read(principal, taskId())),
          },
        });
      case "tasks/update": {
        const parsed = UpdateTaskRequestV2Schema.safeParse({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        });
        if (!parsed.success)
          throw new RpcError(E.params, "Invalid tasks/update params");
        await deps.service.answer(
          principal,
          taskId(),
          parsed.data.params.inputResponses as Record<string, unknown>,
        );
        return json({ jsonrpc: "2.0", id, result: { resultType: "complete" } });
      }
      case "tasks/cancel":
        await deps.service.cancel(principal, taskId());
        return json({ jsonrpc: "2.0", id, result: { resultType: "complete" } });
      default:
        // tasks/list and tasks/result do not exist in this extension; subscriptions are not advertised.
        throw new RpcError(E.method, "Method not found");
    }
  } catch (e) {
    if (e instanceof RpcError)
      return json(
        {
          jsonrpc: "2.0",
          id,
          error: {
            code: e.code,
            message: e.message,
            ...(e.data ? { data: e.data } : {}),
          },
        },
        e.http,
      );
    if (e instanceof AppError)
      return json({
        jsonrpc: "2.0",
        id,
        error: {
          code:
            e.status === 404
              ? E.params
              : e.status >= 500
                ? E.internal
                : E.params,
          message: e.status === 404 ? "Task not found" : e.code,
        },
      });
    console.error(
      JSON.stringify({
        event: "mcp_failed",
        type: e instanceof Error ? e.name : "unknown",
      }),
    );
    return json(
      {
        jsonrpc: "2.0",
        id,
        error: { code: E.internal, message: "dependency_unavailable" },
      },
      200,
    );
  }
}
