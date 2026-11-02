// Refund Workflow: a refund agent as a Cloudflare Workflow, gated by approve().
// The engine holds the wait (step.waitForEvent); approve() decides whether the event
// that resumes it is a real decision: a fresh passkey sign-in at Auth0 by someone with
// the finance role, for exactly this refund. Setup is one Auth0 application and one
// Action; there is no Task Authority service, FGA store or database here.
//
// Only the refund itself is a stand-in (Stripe is the one thing this repo may mock),
// keyed by the approval's idempotency key exactly as a Stripe call would be.
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { ApprovalRejected } from "@task-authority/sdk/approve";
import {
  approvalRoutes,
  approve,
} from "@task-authority/sdk/approve/cloudflare";
import { home, refundPage } from "./pages.js";

type Params = { paymentId: string; amountMinor: number; expiresIn?: string };
type Env = {
  REFUNDS: Workflow<Params>;
  LINKS: KVNamespace;
  APPROVAL_FINANCE_ROLE?: string;
  [k: string]: unknown;
};

export class RefundWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const p = event.payload;
    try {
      const ok = await approve(step, event, this.env, {
        action: "refund:create",
        resource: `payment:${p.paymentId}`,
        args: {
          paymentId: p.paymentId,
          amountMinor: p.amountMinor,
          currency: "USD",
        },
        approvers: { roles: [this.env.APPROVAL_FINANCE_ROLE ?? "finance"] },
        requester: "agent_returns",
        summary: `Refund ${(p.amountMinor / 100).toFixed(2)} USD`,
        expiresIn: p.expiresIn ?? "30 minutes",
        // A real app emails or messages the finance team. The demo shows the link.
        notify: (link) =>
          this.env.LINKS.put(event.instanceId, link, { expirationTtl: 86400 }),
      });
      const refund = await step.do("refund", async () => ({
        id: `re_${ok.key.slice(4, 20)}`,
        idempotencyKey: ok.key,
      }));
      return {
        status: "refunded",
        approvedBy: ok.approver.sub,
        approverName: ok.approver.name ?? null,
        method: ok.method,
        refund,
      };
    } catch (e) {
      if (e instanceof ApprovalRejected)
        return { status: "rejected", by: e.approval.approver.sub };
      throw e;
    }
  }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const routed = await approvalRoutes(req, env, {
      workflow: env.REFUNDS,
      appName: "Refund Workflow",
    });
    if (routed) return routed;
    const url = new URL(req.url);
    const [, a, b, c] = url.pathname.split("/");
    if (url.pathname === "/" && req.method === "GET") return home();
    if (a === "api" && b === "refunds" && !c && req.method === "POST") {
      const input = (await req.json()) as Partial<Params>;
      const amountMinor = Number(input.amountMinor);
      if (
        typeof input.paymentId !== "string" ||
        !ID.test(input.paymentId) ||
        !Number.isSafeInteger(amountMinor) ||
        amountMinor <= 0
      )
        return Response.json({ error: "invalid_request" }, { status: 400 });
      const instance = await env.REFUNDS.create({
        params: {
          paymentId: input.paymentId,
          amountMinor,
          ...(input.expiresIn ? { expiresIn: input.expiresIn } : {}),
        },
      });
      return Response.json({ id: instance.id }, { status: 201 });
    }
    if (a === "refunds" && b && ID.test(b) && req.method === "GET")
      return refundPage(b);
    if (a === "api" && b === "refunds" && c && ID.test(c)) {
      const instance = await env.REFUNDS.get(c);
      if (url.pathname.endsWith("/forge") && req.method === "POST") {
        // Anyone who can reach the engine can send it events. This button lets you
        // try: the event arrives, approve() refuses it, and the run keeps waiting.
        const { type } = (await req.json()) as { type?: string };
        if (typeof type !== "string" || !/^approval-[a-f0-9]{24}$/.test(type))
          return Response.json({ error: "invalid_request" }, { status: 400 });
        await instance.sendEvent({
          type,
          payload: {
            proof:
              "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdXRoMHxtYWxsb3J5IiwibmFtZSI6Ik1hbGxvcnkifQ.Zm9yZ2Vk",
          },
        });
        return new Response(null, { status: 204 });
      }
      const status = await instance.status();
      return Response.json({ ...status, link: await env.LINKS.get(c) });
    }
    return new Response("Not found", { status: 404 });
  },
};
