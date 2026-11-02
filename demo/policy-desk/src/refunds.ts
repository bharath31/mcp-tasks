// The customer app of the sandbox: POST /v1/refunds. Adaptation of
// demo/refund-desk (app.ts + workflow.ts): the same protected refund action
// and REST transport mapping, minus the Node-only MCP Tasks service,
// warehouse return stage, worker loop and Stripe adapter. Business validation
// reuses refund-desk's policy.ts and refund.ts helpers unchanged.
import { dpopOk } from "./dpop.js";
import { decodeJwt } from "jose";
import {
  approvalConfig,
  approvalLink,
  createApprovalRequest,
} from "@task-authority/sdk/approve";
import { createPostgresApprovalLedger } from "@task-authority/sdk/approve/ledger";
import { TaskAuthorityError } from "@task-authority/sdk";
import { z } from "zod";
import { isEligible } from "../../refund-desk/src/policy.js";
import { stateVersion } from "../../refund-desk/src/refund.js";
import {
  appAudience,
  authorityAudience,
  bearer,
  clientIdOf,
  verifyToken,
} from "./auth0.js";
import { boundSandboxId } from "./agent-keys.js";
import { MAX_OPERATIONS_PER_GENERATION } from "./env.js";
import {
  loadSandbox,
  sandboxIdFor,
  authorityApp,
  sdk,
  SANDBOX_ID,
  tenantIdOf,
  type Host,
  type Sandbox,
} from "./host.js";
import { json, problem, REASONS } from "./problem.js";
import { getOrder, simulateRefund } from "./orders.js";
import { delegationFresh } from "./seed.js";
import { Guardrail, fromGuardrail } from "./problem.js";

export type Principal = {
  sub: string;
  token: string;
  actorType: "agent" | "human";
};

export const errorBody = (
  status: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
) => problem(status, error, message, extra);

export const SANDBOX_HEADER = "x-policy-desk-sandbox";

/**
 * Authenticates the caller with the REAL Auth0 tenant keys and picks the sandbox.
 * Humans own the sandbox derived from their subject. The agent is the Auth0
 * M2M client driven by this Worker (it sends the sandbox id in an internal header),
 * or a visitor's own agent holding a sandbox agent key (agent-keys.ts).
 */
export async function resolve(
  host: Host,
  req: Request,
  extraAudiences: string[] = [],
): Promise<{ sandbox: Sandbox; who: Principal } | Response> {
  const token = bearer(req);
  if (!token)
    return problem(
      401,
      "invalid_identity",
      REASONS.invalid_identity!.message,
      REASONS.invalid_identity,
    );
  const v = await verifyToken(host.env, token, [
    authorityAudience(host.env),
    appAudience(host.env),
    ...extraAudiences,
  ]);
  if (!v || !(await dpopOk(host.conn.db, req, token, v.payload)))
    return problem(
      401,
      "invalid_identity",
      REASONS.invalid_identity!.message,
      REASONS.invalid_identity,
    );
  let sandbox: Sandbox | null = null;
  let who: Principal;
  const external = host.env.EXTERNAL_AGENT_CLIENT_ID;
  if (v.isClient && external && v.payload.azp === external) {
    // A visitor's own agent: the sandbox comes only from the key's binding, never the request.
    const bound = await boundSandboxId(host, token);
    if (!bound)
      return problem(
        401,
        "invalid_identity",
        "This agent key was replaced, disconnected or has expired.",
        {
          hint: "Copy a new key from Connect your agent in the Policy Desk console.",
          nextAction: "sign_in",
        },
      );
    const named = req.headers.get(SANDBOX_HEADER);
    if (named && named !== bound)
      return problem(
        403,
        "wrong_sandbox",
        "This agent key belongs to a different sandbox.",
        {
          hint: "Drop the sandbox header; the key already names its sandbox.",
          nextAction: "none",
        },
      );
    sandbox = await loadSandbox(host, bound);
    who = { sub: v.sub, token, actorType: "agent" };
  } else if (v.isClient) {
    if (v.payload.azp !== clientIdOf(host.env, "agent"))
      return problem(
        403,
        "unregistered_agent",
        "This client is not a registered agent.",
        {
          hint: "Use the agent key from Connect your agent in the Policy Desk console.",
          nextAction: "none",
        },
      );
    const id = req.headers.get(SANDBOX_HEADER) ?? "";
    sandbox = SANDBOX_ID.test(id) ? await loadSandbox(host, id) : null;
    who = { sub: v.sub, token, actorType: "agent" };
  } else {
    sandbox = await loadSandbox(host, await sandboxIdFor(v.sub));
    who = { sub: v.sub, token, actorType: "human" };
    if (sandbox && sandbox.orgId !== v.orgId)
      return problem(
        403,
        "wrong_organization",
        "Your token is for a different organization than your sandbox.",
        {
          hint: "Sign in through the sandbox organization.",
          nextAction: "sign_in",
        },
      );
  }
  if (!sandbox)
    return problem(
      404,
      "sandbox_not_initialized",
      "Your sandbox does not exist: it was never created, or it expired and was deleted.",
      {
        hint: "Create a new one with POST /sandbox/reset.",
        nextAction: "reset_sandbox",
      },
    );
  if (sandbox.expiresAt.getTime() <= host.now())
    return problem(
      410,
      "sandbox_expired",
      "This sandbox expired and is being deleted.",
      {
        hint: "Create a fresh one.",
        nextAction: "reset_sandbox",
      },
    );
  return { sandbox, who };
}

export const refundBody = z
  .object({
    orderId: z.string().min(1).max(60),
    amountMinor: z.number().int().positive().max(50_000_000),
    currency: z.literal("USD").default("USD"),
    reason: z.string().max(200).optional(),
    action: z
      .string()
      .regex(/^[a-z_]{1,30}:[a-z_]{1,30}$/)
      .default("refund:create"),
    approvalAssertion: z.enum(["none", "human"]).optional(),
  })
  .strict();

async function operationCapOk(host: Host, s: Sandbox) {
  const r = await host.conn.db.query(
    "select count(*)::int n from authority.operations where tenant_id=$1",
    [tenantIdOf(s)],
  );
  return r.rows[0].n < MAX_OPERATIONS_PER_GENERATION;
}

function requireDelegation(host: Host, s: Sandbox) {
  if (delegationFresh(host, s)) return s.delegationId!;
  throw new Guardrail(
    409,
    "delegation_expired",
    "The agent's delegation from you has expired.",
    {
      hint: "Run a scenario or reset the sandbox; the Worker then re-grants the delegation from the agent's owner.",
      nextAction: "reset_sandbox",
    },
  );
}

function mapError(e: unknown): Response {
  if (e instanceof Guardrail) return fromGuardrail(e);
  if (e instanceof TaskAuthorityError) {
    const status = e.status || 502;
    const reason = String(e.details?.reason ?? e.code);
    const r = REASONS[reason] ?? REASONS[e.code];
    return json(
      {
        ...(status === 403 ? { decision: "deny" } : {}),
        reasonCode: reason,
        executed: false,
        error: { code: e.code, message: e.message, details: e.details ?? null },
        reason,
        message: r?.message ?? e.message,
        hint: r?.hint ?? null,
        nextAction: r?.nextAction ?? null,
      },
      status,
      e.details?.retryAfterSec
        ? { "retry-after": String(e.details.retryAfterSec) }
        : {},
    );
  }
  throw e;
}

export async function createRefund(
  host: Host,
  s: Sandbox,
  req: Request,
  who: Principal,
): Promise<Response> {
  return requestRefund(
    host,
    s,
    await req.json().catch(() => null),
    req.headers.get("idempotency-key"),
    who,
  );
}

/** The one refund path. REST (`POST /v1/refunds`) and the MCP `request_refund` tool both call it. */
export async function requestRefund(
  host: Host,
  s: Sandbox,
  input: unknown,
  idem: string | null,
  who: Principal,
): Promise<Response> {
  const parsed = refundBody.safeParse(input);
  if (!parsed.success)
    return errorBody(400, "invalid_request", "Body failed validation.", {
      issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join(".")),
    });
  const b = parsed.data;
  const tenantId = tenantIdOf(s);
  const order = await getOrder(host.conn.db, tenantId, b.orderId);
  if (!order)
    return errorBody(404, "order_not_found", "No such order in this sandbox.", {
      hint: "Pick an order from the sandbox list.",
      nextAction: "pick_order",
    });
  if (!(await operationCapOk(host, s)))
    return errorBody(
      429,
      "sandbox_operation_limit",
      "This sandbox reached its limit of operations.",
      { hint: "Reset the sandbox to start over.", nextAction: "reset_sandbox" },
    );
  const payment = {
    amountMinor: order.amountMinor,
    refundedMinor: order.refundedMinor,
  };
  if (!isEligible({ amountMinor: b.amountMinor, payment }))
    return errorBody(
      409,
      "refund_not_eligible",
      "Amount exceeds the refundable balance.",
      { hint: "Choose a smaller amount.", nextAction: "change_amount" },
    );

  const operationKey = `pd:${tenantIdOf(s)}:${idem && /^[A-Za-z0-9_\-.:]{8,100}$/.test(idem) ? idem : crypto.randomUUID()}`;
  if (host.env.APPROVAL_MODE === "approve") {
    try {
      if (who.actorType === "agent") requireDelegation(host, s);
      const cfg = approvalConfig(host.env, {
        appUrl: host.env.APP_URL ?? host.origin,
        clientId: host.env.APPROVAL_CLIENT_ID ?? host.env.AUTH0_CLIENT_ID,
        clientSecret:
          host.env.APPROVAL_CLIENT_SECRET ?? host.env.AUTH0_CLIENT_SECRET,
        fetch: host.env.APPROVAL_FETCH,
      });
      const tokenClaims = decodeJwt(who.token);
      const cnf = tokenClaims.cnf as { jkt?: unknown } | undefined;
      const name = `refund:create ${order.orderId}`;
      const candidate = await createApprovalRequest({
        action: b.action,
        resource: `payment:${order.orderId}`,
        args: {
          orderId: order.orderId,
          amountMinor: b.amountMinor,
          currency: b.currency,
          ...(b.reason ? { reason: b.reason } : {}),
        },
        version: stateVersion({ ...payment, currency: b.currency }),
        approvers: { roles: [host.env.APPROVAL_ROLE ?? "finance"] },
        requester: who.sub,
        ...(typeof cnf?.jkt === "string" ? { requesterJkt: cnf.jkt } : {}),
        summary: `Refund ${(b.amountMinor / 100).toFixed(2)} ${b.currency} for order ${order.orderId}`,
        expiresIn: "15 minutes",
        run: operationKey,
        step: name,
      });
      const ledger = createPostgresApprovalLedger(host.conn.db, cfg, {
        table: "policy_desk.approval_requests",
      });
      const inserted = await host.conn.db.query(
        `insert into policy_desk.approval_requests
           (id, request, expires_at, tenant_id, sandbox_id, generation)
         values ($1, $2::jsonb, to_timestamp($3), $4, $5, $6)
         on conflict (tenant_id, sandbox_id, generation, (request->>'run')) do nothing
         returning id`,
        [
          candidate.id,
          JSON.stringify(candidate),
          candidate.exp,
          tenantId,
          s.id,
          s.generation,
        ],
      );
      let request = candidate;
      if (!inserted.rows.length) {
        const existing = (
          await host.conn.db.query<{ request: typeof candidate | string }>(
            `select request from policy_desk.approval_requests
             where tenant_id=$1 and sandbox_id=$2 and generation=$3
               and request->>'run'=$4`,
            [tenantId, s.id, s.generation, operationKey],
          )
        ).rows[0];
        if (!existing)
          throw new Error(
            "Approval task disappeared after an idempotency conflict.",
          );
        request =
          typeof existing.request === "string"
            ? (JSON.parse(existing.request) as typeof candidate)
            : existing.request;
        if (request.digest !== candidate.digest)
          return errorBody(
            409,
            "idempotency_conflict",
            "This Idempotency-Key was already used for different refund details.",
          );
      }
      const link = await approvalLink(cfg, request, ledger);
      return Response.json(
        {
          approvalTask: true,
          id: request.id,
          operationKey,
          createdAt: new Date(request.iat * 1000).toISOString(),
          expiresAt: new Date(request.exp * 1000).toISOString(),
          link,
        },
        { status: 202 },
      );
    } catch (e) {
      return mapError(e);
    }
  }
  try {
    const refund = refundAction(host, s, b.action);
    const outcome = await refund(
      {
        merchant: s.orgId,
        orderId: order.orderId,
        paymentId: order.orderId,
        amountMinor: b.amountMinor,
        currency: b.currency,
        destination: "original_payment_method",
      },
      {
        user: who.actorType === "human" ? who.token : undefined,
        delegation:
          who.actorType === "agent" ? requireDelegation(host, s) : undefined,
        key: operationKey,
        version: stateVersion({ ...payment, currency: b.currency }),
        facts: {
          orderId: order.orderId,
          customer: order.customer,
          amountMinor: b.amountMinor,
          reason: b.reason ?? "",
          paymentAmountMinor: order.amountMinor,
          refundedMinor: order.refundedMinor,
        },
        approvalAssertion: b.approvalAssertion,
      },
    );
    return outcome.toResponse();
  } catch (e) {
    return mapError(e);
  }
}

type RefundInput = {
  merchant: string;
  orderId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  destination: string;
};

/** The protected refund, declared once. REST, MCP and resume all call it. */
function refundAction(host: Host, s: Sandbox, action = "refund:create") {
  return authorityApp(host, s).action(action, {
    resource: (r: RefundInput) => `payment:${r.orderId}`,
    run: (r, { claim, key }) =>
      execute(host, tenantIdOf(s), claim, r.orderId, r.amountMinor, key),
    // After an uncertain claim the ledger is the provider of record: look the refund up
    // under the operation key instead of running it again or guessing.
    reconcile: (r, { claim, key }) =>
      reconcile(host, tenantIdOf(s), claim, r.orderId, key),
  });
}

type Reporter = {
  claimId: string;
  report: (
    st: "succeeded" | "failed" | "unknown",
    ref?: string,
  ) => Promise<unknown>;
};

async function execute(
  host: Host,
  tenantId: string,
  claim: Reporter,
  orderId: string,
  amountMinor: number,
  operationKey: string,
) {
  let r;
  try {
    r = await simulateRefund(host.conn.db, tenantId, {
      orderId,
      amountMinor,
      idempotencyKey: operationKey,
      claimId: claim.claimId,
    });
  } catch (e) {
    // Only the balance check, made before anything is written, is a definite failure.
    // Any other error (a connection lost at commit, say) may have moved money.
    const definite =
      e instanceof Error && e.message === "amount_exceeds_refundable_balance";
    await claim.report(definite ? "failed" : "unknown").catch(() => undefined);
    throw e;
  }
  try {
    await claim.report("succeeded", r.refundId);
  } catch {
    // The refund committed and only the report was lost. "unknown" sends the next claim
    // to reconciliation; it must never become a recorded failure.
    await claim.report("unknown", r.refundId).catch(() => undefined);
  }
  return { ...r, orderId, currency: "USD", simulator: true as const };
}

async function reconcile(
  host: Host,
  tenantId: string,
  claim: Reporter,
  orderId: string,
  operationKey: string,
) {
  const row = (
    await host.conn.db.query(
      "select refund_id, amount_minor from policy_desk.refunds where idempotency_key=$1 and tenant_id=$2",
      [operationKey, tenantId],
    )
  ).rows[0];
  // Nothing under this key: the SDK reports not_submitted.
  if (!row) return null;
  await claim.report("succeeded", row.refund_id as string);
  return {
    refundId: row.refund_id as string,
    status: "succeeded" as const,
    amountMinor: row.amount_minor as number,
    orderId,
    currency: "USD",
    simulator: true as const,
  };
}

/** Resume an operation after the reviewers decided. */
export async function runRefund(
  host: Host,
  s: Sandbox,
  operationId: string,
): Promise<Response> {
  try {
    const op = await sdk(host, s, "api").operations.get(operationId);
    if (op.organizationId !== s.orgId)
      return errorBody(404, "not_found", "Not found.");
    // The demo's durable record of the request is the operation's own facts.
    const orderId = String(op.facts?.orderId ?? "");
    const outcome = await refundAction(host, s, op.action).resume(op.id, {
      merchant: s.orgId,
      orderId,
      paymentId: orderId,
      amountMinor: Number(op.facts?.amountMinor ?? 0),
      currency: "USD",
      destination: "original_payment_method",
    });
    return outcome.toResponse();
  } catch (e) {
    return mapError(e);
  }
}

export async function getRefund(host: Host, s: Sandbox, operationId: string) {
  const authority = sdk(host, s, "api");
  try {
    const op = await authority.operations.get(operationId);
    if (op.organizationId !== s.orgId)
      return errorBody(404, "not_found", "Not found.");
    const order = await getOrder(
      host.conn.db,
      tenantIdOf(s),
      String(op.facts?.orderId ?? ""),
    );
    const refund = await host.conn.db.query(
      "select refund_id, amount_minor, status, created_at from policy_desk.refunds where idempotency_key=$1 and tenant_id=$2",
      [op.operationKey, tenantIdOf(s)],
    );
    return json({ operation: op, order, refund: refund.rows[0] ?? null });
  } catch (e) {
    return mapError(e);
  }
}
