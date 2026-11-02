// Canned agent requests. Every one goes through the Worker's public router as
// `POST /v1/refunds` with a persona bearer token, i.e. exactly what a real
// client sends; nothing here calls the policy engine directly.
import { renderCli, renderMcp } from "@task-authority/sdk";
import { clientToken } from "./auth0.js";
import { tenantIdOf, type Host, type Sandbox } from "./host.js";
import { createOrder } from "./orders.js";
import { SANDBOX_HEADER } from "./refunds.js";

/** `agent` is the real Auth0 M2M agent client; `you` is the signed-in Auth0 user. */
type Persona = "agent" | "you";

type Expect = { status: number; decision: string; reasonCode?: string };
export type ScenarioDef = {
  id: string;
  title: string;
  description: string;
  as: Persona;
  expect: Expect;
};
export const SCENARIOS: ScenarioDef[] = [
  {
    id: "small_within_budget",
    title: "Small refund within budget",
    description:
      "The agent refunds $40. Policy allows it automatically inside the agent budget.",
    as: "agent",
    expect: { status: 201, decision: "allow" },
  },
  {
    id: "routine_approval",
    title: "$150 needs routine approval",
    description:
      "Over $100 the agent must wait for one reviewer with an MFA session.",
    as: "agent",
    expect: { status: 202, decision: "approval_required" },
  },
  {
    id: "high_value",
    title: "$1,500 needs high-value approval",
    description:
      "Over $1,000 needs two different reviewers approving this exact operation.",
    as: "agent",
    expect: { status: 202, decision: "approval_required" },
  },
  {
    id: "budget_exhausted",
    title: "Agent budget exhausted",
    description:
      "The agent keeps refunding $100 until its $500 daily budget runs out; the next one needs approval.",
    as: "agent",
    expect: { status: 202, decision: "approval_required" },
  },
  {
    id: "unknown_action",
    title: "Unknown action is denied",
    description:
      "The agent asks for an action the policy never named (refund:void). Default is deny.",
    as: "agent",
    expect: { status: 403, decision: "deny" },
  },
  {
    id: "assert_none",
    title: "Caller asserts approvalAssertion: none",
    description:
      "The caller claims no approval is needed for $150. Callers can only raise the requirement, never lower it.",
    as: "agent",
    expect: { status: 202, decision: "approval_required" },
  },
  {
    id: "self_approval",
    title: "Requester cannot approve their own request",
    description:
      "You request a $1,500 refund; the review queue then hides your own request, and the service refuses a self-approval.",
    as: "you",
    expect: { status: 202, decision: "approval_required" },
  },
  {
    id: "human_step_up",
    title: "Human step-up",
    description:
      "You refund $600 directly. Without a fresh MFA session the service answers 401 with a step-up challenge; complete MFA and run it again.",
    as: "you",
    expect: { status: 401, decision: "step_up_required" },
  },
];

export type Step = {
  request: { as: Persona; body: Record<string, unknown> };
  status: number;
  decision: string | null;
  reasonCode: string | null;
  headers?: Record<string, string>;
};

type Call = (req: Request) => Promise<Response>;

export async function runScenario(
  host: Host,
  s: Sandbox,
  id: string,
  call: Call,
  visitorToken: string,
) {
  const def = SCENARIOS.find((x) => x.id === id);
  if (!def) return null;
  const tenantId = tenantIdOf(s);
  const steps: Step[] = [];
  const refundCalls: Array<{ step: Step; body: any }> = [];
  const order = (amountMinor: number, label = "Scenario order") =>
    createOrder(host.conn.db, tenantId, s.id, {
      customer: "Scenario Customer",
      item: label,
      amountMinor,
    });

  const send = async (as: Persona, body: Record<string, unknown>) => {
    const token =
      as === "agent"
        ? await clientToken(host.env, host.deps, "agent")
        : visitorToken;
    const res = await call(
      new Request(`${host.origin}/v1/refunds`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [SANDBOX_HEADER]: s.id,
          "idempotency-key": `sc:${id}:${crypto.randomUUID()}`,
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    const headers: Record<string, string> = {};
    for (const h of [
      "location",
      "www-authenticate",
      "content-type",
      "retry-after",
    ]) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    const step: Step = {
      request: { as, body },
      status: res.status,
      decision: parsed?.decision ?? null,
      reasonCode: parsed?.reasonCode ?? null,
      headers,
    };
    steps.push(step);
    refundCalls.push({ step, body: parsed });
    return { status: res.status, body: parsed, headers };
  };

  let last: Awaited<ReturnType<typeof send>>;
  switch (id) {
    case "small_within_budget": {
      const o = await order(20000);
      last = await send("agent", {
        orderId: o.orderId,
        amountMinor: 4000,
        currency: "USD",
        reason: "Damaged on arrival",
      });
      break;
    }
    case "routine_approval": {
      const o = await order(40000);
      last = await send("agent", {
        orderId: o.orderId,
        amountMinor: 15000,
        currency: "USD",
        reason: "Wrong size returned",
      });
      break;
    }
    case "high_value": {
      const o = await order(250000);
      last = await send("agent", {
        orderId: o.orderId,
        amountMinor: 150000,
        currency: "USD",
        reason: "Defective unit",
      });
      break;
    }
    case "budget_exhausted": {
      const o = await order(200000);
      for (let i = 0; i < 8; i++) {
        last = await send("agent", {
          orderId: o.orderId,
          amountMinor: 10000,
          currency: "USD",
          reason: `Partial refund ${i + 1}`,
        });
        if (last.status !== 201) break;
      }
      last = last!;
      break;
    }
    case "unknown_action": {
      const o = await order(20000);
      last = await send("agent", {
        orderId: o.orderId,
        amountMinor: 5000,
        currency: "USD",
        action: "refund:void",
      });
      break;
    }
    case "assert_none": {
      const o = await order(40000);
      last = await send("agent", {
        orderId: o.orderId,
        amountMinor: 15000,
        currency: "USD",
        approvalAssertion: "none",
      });
      break;
    }
    case "self_approval": {
      const o = await order(250000);
      last = await send("you", {
        orderId: o.orderId,
        amountMinor: 150000,
        currency: "USD",
        reason: "Defective unit",
      });
      const approvalId = last.body?.operation?.approvalId;
      if (approvalId) {
        const q = await call(
          new Request(`${host.origin}/v1/approval-requests?status=pending`, {
            headers: { authorization: `Bearer ${visitorToken}` },
          }),
        );
        const qb = (await q.json().catch(() => ({}))) as any;
        const listed = (qb.approvals ?? []).some(
          (a: any) => a.id === approvalId,
        );
        steps.push({
          request: { as: "you", body: { listPendingApprovals: true } },
          status: q.status,
          decision: listed ? "allow" : "deny",
          reasonCode: listed
            ? "own_request_visible"
            : "own_request_hidden_from_queue",
        });
      }
      break;
    }
    case "human_step_up": {
      const o = await order(100000);
      last = await send("you", {
        orderId: o.orderId,
        amountMinor: 60000,
        currency: "USD",
        reason: "Goodwill",
      });
      break;
    }
    default:
      return null;
  }
  const final = refundCalls[refundCalls.length - 1]!;
  const body = final.body;
  const isOutcome = body && typeof body.decision === "string" && body.operation;
  return {
    scenario: { id: def.id, title: def.title },
    request: {
      method: "POST",
      path: "/v1/refunds",
      as: final.step.request.as,
      body: final.step.request.body,
    },
    response: {
      status: final.step.status,
      headers: final.step.headers ?? {},
      body,
    },
    decision: final.step.decision,
    reasonCode: final.step.reasonCode,
    operationId: body?.operation?.id ?? null,
    approvalId: body?.operation?.approvalId ?? null,
    cli: isOutcome ? renderCli(body) : null,
    mcp: isOutcome ? renderMcp(body) : null,
    steps: steps.length > 1 ? steps : [],
    explain:
      id === "budget_exhausted" &&
      refundCalls.length > 1 &&
      final.step.status === 202
        ? {
            reason: "budget_exhausted",
            message: `After ${refundCalls.length - 1} automatic refunds the agent's budget rule no longer applies, so policy falls back to requiring approval.`,
          }
        : null,
    expect: def.expect,
  };
}
