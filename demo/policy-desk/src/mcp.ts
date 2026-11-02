// The refund app's MCP channel: an MCP Tasks (io.modelcontextprotocol/tasks, spec
// 2026-07-28) receiver at POST /mcp, the same wire contract as demo/refund-desk/src/mcp.ts.
// It is a thin surface over the resource server: request_refund calls the exact
// function behind POST /v1/refunds, so Task Authority decides every refund the same way
// whichever client asks. Nothing here can approve, and no tool argument names an identity.
import {
  DetailedTaskV2Schema,
  TASKS_EXTENSION_ID_V2,
  hasTaskClientCapabilityV2,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import {
  TaskAuthorityError,
  stepUpChallenge,
  type OperationView,
} from "@task-authority/sdk";
import {
  ApprovalError,
  ApprovalRejected,
  approvalConfig,
  approvalLink,
  verifyApproval,
  type ApprovalRequest,
} from "@task-authority/sdk/approve";
import { createPostgresApprovalLedger } from "@task-authority/sdk/approve/ledger";
import { z } from "zod";
import { bearer, mcpResource } from "./auth0.js";
import { mcpChallenge } from "./oauth-metadata.js";
import { sdk, tenantIdOf, type Host, type Sandbox } from "./host.js";
import { getOrder, listOrders, simulateRefund, type Order } from "./orders.js";
import { isEligible } from "../../refund-desk/src/policy.js";
import { REASONS } from "./problem.js";
import {
  requestRefund,
  resolve,
  runRefund,
  type Principal,
} from "./refunds.js";

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
const POLL_MS = 3000;
const TASK_TTL_MS = 24 * 3600_000;

/** Hosts relay only the message to the model, so it names what is missing and what to do. */
const MISSING_TASKS =
  "Missing required client capability: io.modelcontextprotocol/tasks. request_refund runs as an MCP task; call it from a client session that supports MCP tasks.";

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly http = 200,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const refundArgs = z
  .object({
    orderId: z.string().min(1).max(60).describe("Order id, e.g. ord_…"),
    amountMinor: z
      .number()
      .int()
      .positive()
      .max(50_000_000)
      .describe("Amount to refund in cents (USD). $40.00 is 4000."),
    reason: z
      .string()
      .min(1)
      .max(200)
      .describe("Why the customer is owed this refund, in a few words."),
  })
  .strict();

export const TOOLS = [
  {
    name: "list_orders",
    title: "List orders",
    description:
      "List the merchant's orders with customer, item, amount paid and amount already refunded (all amounts in cents, USD).",
    schema: z.object({}).strict(),
    task: false,
  },
  {
    name: "get_order",
    title: "Get an order",
    description:
      "Read one order: customer, item, amount paid and amount already refunded (cents, USD).",
    schema: z.object({ orderId: z.string().min(1).max(60) }).strict(),
    task: false,
  },
  {
    name: "request_refund",
    title: "Request a refund",
    description:
      "Refund part or all of an order to the original payment method. Long-running: returns a task. Task Authority evaluates the merchant's policy and may refund at once, wait for a human reviewer, or refuse. Read the outcome with tasks/get. You cannot approve your own request.",
    schema: refundArgs,
    task: true,
  },
] as const;

const orderView = (o: Order) => ({
  orderId: o.orderId,
  customer: o.customer,
  item: o.item,
  amountMinor: o.amountMinor,
  refundedMinor: o.refundedMinor,
  refundableMinor: o.amountMinor - o.refundedMinor,
  currency: o.currency,
});

const toolResult = (data: Record<string, unknown>, isError = false) => ({
  resultType: "complete" as const,
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredContent: data,
  isError,
});

/** Task Authority's decision, attached to every task so a client can show why. */
const authorityMeta = (op: OperationView, reviewUrl?: string | null) => ({
  "task-authority/decision": {
    operationId: op.id,
    decision: op.decision ?? null,
    reasonCode: op.reasonCode ?? null,
    policyVersion: op.policyVersion ?? null,
    ruleIds: op.ruleIds ?? [],
    tier: op.tier ?? null,
    approvalId: op.approvalId,
    ...(reviewUrl ? { reviewUrl } : {}),
  },
});

// Absolute: hosts show statusMessage outside the page (Claude Code's /tasks), where a path is useless.
const reviewUrlFor = (host: Host, s: Sandbox, approvalId: string | null) =>
  approvalId
    ? `${host.origin}/review?approval=${encodeURIComponent(approvalId)}&sandbox=${encodeURIComponent(s.id)}`
    : null;

const message = (code: string | null | undefined) =>
  (code && REASONS[code]?.message) || code || "refused";

/**
 * How the refund was authorized, in the result itself: the model summarizes the result for the
 * user, and without this it guesses (wrongly) that nobody had to approve.
 */
const approvalOf = (op: OperationView) =>
  op.approvalRequirement === "human"
    ? {
        required: true,
        approvalId: op.approvalId,
        status: op.approvalStatus,
      }
    : { required: false, reason: "allowed by policy without a person" };

/** Maps the operation's authority state onto an MCP task. Polling never decides anything. */
async function taskOf(host: Host, s: Sandbox, op: OperationView) {
  const { db } = host.conn;
  const created = (
    await db.query(
      "select created_at from authority.operations where id=$1 and tenant_id=$2",
      [op.id, tenantIdOf(s)],
    )
  ).rows[0]?.created_at;
  const base = {
    taskId: op.id,
    createdAt: new Date(created ?? host.now()).toISOString(),
    lastUpdatedAt: new Date(host.now()).toISOString(),
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: POLL_MS,
  };
  const refund = (
    await db.query(
      "select refund_id, amount_minor from policy_desk.refunds where idempotency_key=$1 and tenant_id=$2",
      [op.operationKey, tenantIdOf(s)],
    )
  ).rows[0];
  const review = reviewUrlFor(host, s, op.approvalId);
  const _meta = authorityMeta(op, review);
  if (refund)
    return {
      ...base,
      status: "completed" as const,
      statusMessage: "Refund issued.",
      result: toolResult({
        outcome: "refunded",
        refundId: refund.refund_id,
        amountMinor: refund.amount_minor,
        orderId: op.facts?.orderId ?? null,
        paymentsMode: "simulator",
        approval: approvalOf(op),
      }),
      _meta,
    };
  const fail = (code: string, text: string) => ({
    ...base,
    status: "failed" as const,
    statusMessage: text,
    error: { code: E.internal, message: code, data: { reason: code, text } },
    _meta,
  });
  if (op.decision === "deny")
    return fail(op.reasonCode ?? "denied", message(op.reasonCode));
  if (op.status === "rejected")
    return fail("rejected", "A reviewer rejected this refund.");
  if (op.status === "cancelled")
    return {
      ...base,
      status: "cancelled" as const,
      statusMessage: "Withdrawn before any money moved.",
      _meta,
    };
  if (op.claim?.status === "failed")
    return fail("execution_failed", "The payment provider refused the refund.");
  if (op.approvalStatus === "expired")
    return fail("approval_expired", "No reviewer decided in time.");
  if (op.approvalRequirement === "human" && op.approvalStatus !== "approved")
    return {
      ...base,
      status: "working" as const,
      statusMessage: review
        ? `Waiting for a human reviewer to approve: ${review}`
        : "Waiting for a human reviewer.",
      _meta,
    };
  return {
    ...base,
    status: "working" as const,
    statusMessage: "Authorized; issuing the refund.",
    _meta,
  };
}

/** tasks/get: reads authority state and, once a person approved, redeems the approval exactly once. */
async function readTask(host: Host, s: Sandbox, taskId: string) {
  if (host.env.APPROVAL_MODE === "approve")
    return readApprovalTask(host, s, taskId);
  const authority = sdk(host, s, "api");
  let op = await authority.operations.get(taskId).catch(() => null);
  if (!op || op.organizationId !== s.orgId)
    throw new RpcError(E.params, "Task not found");
  const ready =
    op.decision !== "deny" &&
    (op.status === "registered" || op.status === "claimed") &&
    (op.approvalRequirement === "none" || op.approvalStatus === "approved");
  if (ready) {
    await runRefund(host, s, op.id);
    op = await authority.operations.get(taskId);
  }
  const task = await taskOf(host, s, op);
  // Validate the wire shape; the schema does not model _meta, so carry it across.
  return { ...DetailedTaskV2Schema.parse(task), _meta: task._meta };
}

async function readApprovalTask(host: Host, s: Sandbox, taskId: string) {
  const cfg = approvalConfig(host.env, {
    appUrl: host.env.APP_URL ?? host.origin,
    clientId: host.env.APPROVAL_CLIENT_ID ?? host.env.AUTH0_CLIENT_ID,
    clientSecret:
      host.env.APPROVAL_CLIENT_SECRET ?? host.env.AUTH0_CLIENT_SECRET,
    fetch: host.env.APPROVAL_FETCH,
  });
  const tenantId = tenantIdOf(s);
  const row = (
    await host.conn.db.query<{
      request: ApprovalRequest | string;
      proof: string | null;
      used_at: Date | null;
      cancelled_at: Date | null;
      expires_at: Date;
    }>(
      `select request, proof, used_at, cancelled_at, expires_at
       from policy_desk.approval_requests
       where id=$1 and tenant_id=$2 and sandbox_id=$3 and generation=$4`,
      [taskId, tenantId, s.id, s.generation],
    )
  ).rows[0];
  if (!row) throw new RpcError(E.params, "Task not found");
  const request =
    typeof row.request === "string"
      ? (JSON.parse(row.request) as ApprovalRequest)
      : row.request;
  const base = {
    taskId,
    createdAt: new Date(request.iat * 1000).toISOString(),
    lastUpdatedAt: new Date(host.now()).toISOString(),
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: POLL_MS,
  };
  const _meta = {
    "task-authority/decision": {
      decision: "approval_required",
      reasonCode: "auth0_passkey_approval",
      approvalId: request.id,
    },
  };
  const finish = (task: Record<string, unknown>, metadata = _meta) => ({
    ...DetailedTaskV2Schema.parse(task),
    _meta: metadata,
  });
  if (row.cancelled_at)
    return finish({
      ...base,
      status: "cancelled",
      statusMessage: "Withdrawn before any money moved.",
    });
  const resultFor = async () =>
    (
      await host.conn.db.query(
        "select refund_id, amount_minor from policy_desk.refunds where idempotency_key=$1 and tenant_id=$2",
        [request.run, tenantId],
      )
    ).rows[0];
  const refund = await resultFor();
  if (refund)
    return finish({
      ...base,
      status: "completed" as const,
      statusMessage: "Refund issued after a passkey approval.",
      result: toolResult({
        outcome: "refunded",
        refundId: refund.refund_id,
        amountMinor: refund.amount_minor,
        orderId: request.args.orderId ?? null,
        paymentsMode: "simulator",
        approval: {
          required: true,
          approvalId: request.id,
          status: "approved",
        },
      }),
    });
  if (row.used_at && row.proof) {
    const decision = await verifyApproval(cfg, request, row.proof).catch(
      () => null,
    );
    if (decision?.decision === "reject")
      return finish({
        ...base,
        status: "failed" as const,
        statusMessage: "A reviewer rejected this refund.",
        error: { code: E.internal, message: "approval_rejected" },
      });
    return finish({
      ...base,
      status: "failed" as const,
      statusMessage: "The approval was consumed but no refund was recorded.",
      error: { code: E.internal, message: "refund_not_recorded" },
    });
  }
  if (row.expires_at.getTime() <= host.now())
    return finish({
      ...base,
      status: "failed" as const,
      statusMessage: "The approval request expired before a reviewer decided.",
      error: { code: E.internal, message: "approval_expired" },
    });
  const ledger = createPostgresApprovalLedger(host.conn.db, cfg, {
    table: "policy_desk.approval_requests",
  });
  if (row.proof) {
    try {
      await ledger.consume(taskId, async (r, approval) => {
        const orderId = String(r.args.orderId ?? "");
        const amountMinor = Number(r.args.amountMinor ?? 0);
        const order = await getOrder(host.conn.db, tenantId, orderId);
        if (!order || !isEligible({ amountMinor, payment: order })) return; // Keep the token unused; the task reports that the current balance changed.
        await simulateRefund(host.conn.db, tenantId, {
          orderId,
          amountMinor,
          idempotencyKey: r.run,
          claimId: approval.key,
        });
      });
    } catch (e) {
      if (e instanceof ApprovalRejected) {
        return finish({
          ...base,
          status: "failed" as const,
          statusMessage: "A reviewer rejected this refund.",
          error: { code: E.internal, message: "approval_rejected" },
        });
      }
      if (!(e instanceof ApprovalError)) throw e;
      if (e.code === "provider_error") throw e;
    }
    const completed = await resultFor();
    if (completed)
      return finish({
        ...base,
        status: "completed" as const,
        statusMessage: "Refund issued after a passkey approval.",
        result: toolResult({
          outcome: "refunded",
          refundId: completed.refund_id,
          amountMinor: completed.amount_minor,
          orderId: request.args.orderId ?? null,
          paymentsMode: "simulator",
          approval: {
            required: true,
            approvalId: request.id,
            status: "approved",
          },
        }),
      });
  }
  if (row.proof && !row.used_at) {
    const order = await getOrder(
      host.conn.db,
      tenantId,
      String(request.args.orderId ?? ""),
    );
    if (
      !order ||
      !isEligible({
        amountMinor: Number(request.args.amountMinor ?? 0),
        payment: order,
      })
    )
      return finish({
        ...base,
        status: "failed" as const,
        statusMessage:
          "The refundable balance changed while this request was waiting.",
        error: { code: E.internal, message: "refund_not_eligible" },
      });
  }
  const link = await approvalLink(cfg, request, ledger);
  const waitingMeta = {
    "task-authority/decision": {
      ..._meta["task-authority/decision"],
      reviewUrl: link,
    },
  };
  const task = {
    ...base,
    status: "working" as const,
    statusMessage: `Waiting for a finance reviewer to approve: ${link}`,
  };
  return finish(task, waitingMeta);
}

/**
 * The caller's own task, or -32602. Only "not found" means not found: an outage propagates as
 * an internal error, so a client is never told a live task is gone.
 */
async function ownTask(
  authority: ReturnType<typeof sdk>,
  s: Sandbox,
  taskId: string,
) {
  const op = await authority.operations.get(taskId).catch((e) => {
    if (e instanceof TaskAuthorityError && e.status === 404) return null;
    throw e;
  });
  if (!op || op.organizationId !== s.orgId)
    throw new RpcError(E.params, "Task not found");
  return op;
}

/**
 * tasks/cancel is cooperative (MCP Tasks): acknowledge it, and withdraw the operation if no
 * money has moved. A claimed operation is left to finish and reports its real outcome.
 */
async function cancelTask(host: Host, s: Sandbox, taskId: string) {
  if (host.env.APPROVAL_MODE === "approve") {
    const changed = await host.conn.db.query(
      `update policy_desk.approval_requests set cancelled_at=now(), used_at=now()
       where id=$1 and tenant_id=$2 and sandbox_id=$3 and generation=$4
         and used_at is null and cancelled_at is null and expires_at>now()
       returning id`,
      [taskId, tenantIdOf(s), s.id, s.generation],
    );
    if (changed.rows.length) return;
    const exists = await host.conn.db.query(
      `select id from policy_desk.approval_requests
       where id=$1 and tenant_id=$2 and sandbox_id=$3 and generation=$4`,
      [taskId, tenantIdOf(s), s.id, s.generation],
    );
    if (!exists.rows.length) throw new RpcError(E.params, "Task not found");
    return;
  }
  const authority = sdk(host, s, "api");
  const op = await ownTask(authority, s, taskId);
  if (op.status === "registered")
    await authority.operations.cancel(op.id, { reason: "task_cancelled" });
}

export async function handleMcp(host: Host, req: Request): Promise<Response> {
  const reply = (
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
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const method: string = msg.method;
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
    if (version !== PROTOCOL_VERSION)
      throw new RpcError(
        typeof version === "string" ? E.version : E.invalid,
        typeof version === "string"
          ? "Unsupported protocol version"
          : `Missing _meta["${META_VERSION}"].`,
        { supported: [PROTOCOL_VERSION] },
        400,
      );

    if (method === "server/discover")
      return reply({
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
            [`${M}/serverInfo`]: {
              name: "policy-desk-refunds",
              version: "1.0.0",
            },
          },
          instructions:
            "Policy Desk refunds. request_refund is long-running and returns a task; Task Authority decides it and approvals happen only on the hosted approval page. Payments are simulated.",
        },
      });

    const r = await resolve(host, req, [mcpResource(host.env, host.origin)]);
    if (r instanceof Response) {
      const b = (await r.json().catch(() => ({}))) as { message?: string };
      // Hosts relay only the message, so it says where an outside agent gets credentials.
      const message = bearer(req)
        ? (b.message ?? "unauthorized")
        : "Missing credentials. Send Authorization: Bearer <agent key>; get a key from Connect your agent in the Policy Desk console.";
      return reply(
        {
          jsonrpc: "2.0",
          id,
          error: { code: E.invalid, message },
        },
        r.status,
        r.status === 401
          ? {
              "www-authenticate": mcpChallenge(
                host,
                bearer(req) ? "invalid_token" : undefined,
              ),
            }
          : {},
      );
    }
    const { sandbox: s, who } = r;
    const caps = (meta[META_CAPS] ?? {}) as any;
    const taskCapable =
      hasTaskClientCapabilityV2(caps) ||
      Boolean(caps?.extensions?.[TASKS_EXTENSION_ID_V2]);

    /** tasks/* need the extension declared on the request, and Mcp-Name must agree with taskId. */
    const taskId = () => {
      if (!taskCapable)
        throw new RpcError(E.missingCap, MISSING_TASKS, {
          requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID_V2]: {} } },
        });
      const t = z.string().min(1).max(200).safeParse(params.taskId);
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
        return reply({
          jsonrpc: "2.0",
          id,
          result: {
            resultType: "complete",
            tools: TOOLS.map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: z.toJSONSchema(t.schema, { io: "input" }),
              ...(t.task ? { execution: { taskSupport: "required" } } : {}),
            })),
            // Required on list results from 2026-07-28; the catalog is the same for every caller.
            ttlMs: 3_600_000,
            cacheScope: "public",
          },
        });
      case "tools/call":
        return reply({
          jsonrpc: "2.0",
          id,
          result: await callTool(
            host,
            s,
            who,
            params,
            req.headers.get("idempotency-key"),
            taskCapable,
          ),
        });
      case "tasks/get":
        return reply({
          jsonrpc: "2.0",
          id,
          result: {
            resultType: "complete",
            ...(await readTask(host, s, taskId())),
          },
        });
      case "tasks/update": {
        // Policy Desk never asks the client for input (approval happens on the hosted page),
        // so no key is ever outstanding: acknowledge and ignore, as the spec asks.
        if (host.env.APPROVAL_MODE === "approve") {
          const found = await host.conn.db.query(
            `select id from policy_desk.approval_requests
             where id=$1 and tenant_id=$2 and sandbox_id=$3 and generation=$4`,
            [taskId(), tenantIdOf(s), s.id, s.generation],
          );
          if (!found.rows.length)
            throw new RpcError(E.params, "Task not found");
        } else {
          await ownTask(sdk(host, s, "api"), s, taskId());
        }
        return reply({
          jsonrpc: "2.0",
          id,
          result: { resultType: "complete" },
        });
      }
      case "tasks/cancel":
        await cancelTask(host, s, taskId());
        return reply({
          jsonrpc: "2.0",
          id,
          result: { resultType: "complete" },
        });
      default:
        throw new RpcError(E.method, "Method not found");
    }
  } catch (e) {
    if (e instanceof RpcError)
      return reply(
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
        e.headers,
      );
    console.error(
      JSON.stringify({
        event: "mcp_failed",
        type: e instanceof Error ? e.name : "unknown",
        message: e instanceof Error ? e.message : "",
      }),
    );
    return reply({
      jsonrpc: "2.0",
      id,
      error: { code: E.internal, message: "dependency_unavailable" },
    });
  }
}

async function callTool(
  host: Host,
  s: Sandbox,
  who: Principal,
  params: Record<string, any>,
  idem: string | null,
  taskCapable: boolean,
) {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) throw new RpcError(E.params, `Unknown tool: ${params.name}`);
  const parsed = tool.schema.safeParse(params.arguments ?? {});
  if (!parsed.success)
    return toolResult(
      {
        outcome: "invalid_arguments",
        issues: parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`),
      },
      true,
    );
  const tenantId = tenantIdOf(s);
  if (tool.name === "list_orders")
    return toolResult({
      orders: (await listOrders(host.conn.db, tenantId)).map(orderView),
    });
  if (tool.name === "get_order") {
    const o = await getOrder(
      host.conn.db,
      tenantId,
      (parsed.data as { orderId: string }).orderId,
    );
    return o
      ? toolResult(orderView(o))
      : toolResult({ outcome: "order_not_found" }, true);
  }
  // request_refund: a task is only ever returned to a client that declared the extension.
  if (!taskCapable)
    throw new RpcError(E.missingCap, MISSING_TASKS, {
      requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID_V2]: {} } },
    });
  const args = parsed.data as z.infer<typeof refundArgs>;
  const res = await requestRefund(
    host,
    s,
    { ...args, currency: "USD" },
    idem,
    who,
  );
  const body = (await res.json().catch(() => ({}))) as any;
  if (res.status === 401 && body?.decision === "step_up_required")
    // A person calling through their own MCP client must re-authenticate first (RFC 9470).
    throw new RpcError(
      E.invalid,
      "insufficient_user_authentication",
      { reasonCode: body.reasonCode ?? null },
      401,
      { "www-authenticate": stepUpChallenge(body.operation ?? {}) },
    );
  const op = body?.operation as OperationView | undefined;
  if (!op?.id)
    if (body?.approvalTask === true && typeof body.id === "string") {
      const task = {
        taskId: body.id,
        status: "working" as const,
        statusMessage: `Waiting for a finance reviewer to approve: ${body.link}`,
        createdAt: body.createdAt,
        lastUpdatedAt: body.createdAt,
        ttlMs: TASK_TTL_MS,
        pollIntervalMs: POLL_MS,
        _meta: {
          "task-authority/decision": {
            decision: "approval_required",
            reasonCode: "auth0_passkey_approval",
            approvalId: body.id,
            reviewUrl: body.link,
          },
        },
      };
      return {
        resultType: "task" as const,
        ...DetailedTaskV2Schema.parse(task),
        _meta: task._meta,
      };
    }
  if (!op?.id)
    // Refused before an operation existed (validation, balance, caps): an ordinary tool error.
    return toolResult(
      {
        outcome: body.reason ?? body.reasonCode ?? `http_${res.status}`,
        message: body.message ?? null,
        hint: body.hint ?? null,
      },
      true,
    );
  const task = await taskOf(host, s, op);
  return {
    resultType: "task" as const,
    taskId: task.taskId,
    status: task.status,
    statusMessage: task.statusMessage,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
    _meta: task._meta,
  };
}
