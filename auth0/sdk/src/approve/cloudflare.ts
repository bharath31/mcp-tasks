// Cloudflare Workflows adapter. The wait is the engine's own step.waitForEvent; this
// file only adds what the engine leaves out: checking who decided.
//
//   // in WorkflowEntrypoint.run(event, step)
//   const ok = await approve(step, event, this.env, {
//     action: "refund:create",
//     resource: `payment:${paymentId}`,
//     args: { paymentId, amountMinor: 15000, currency: "USD" },
//     approvers: { roles: ["finance"] },
//     notify: (link) => sendEmail(financeInbox, link),
//   });
//   await stripe.refunds.create({ ... }, { idempotencyKey: ok.key });
//
//   // in the Worker's fetch handler
//   const res = await approvalRoutes(request, env, { workflow: env.REFUNDS });
//   if (res) return res;
import {
  ApprovalError,
  ApprovalExpired,
  ApprovalRejected,
  approvalConfig,
  approvalLink,
  createApprovalRequest,
  pollPush,
  startPush,
  verifyApproval,
  type Approval,
  type ApprovalConfig,
  type ApprovalInput,
  type ApprovalRequest,
  type ApprovalStore,
} from "./core.js";
import { handleApprovalRoute, type ApprovalRoutesOptions } from "./routes.js";

// Structural types, so the SDK needs no dependency on @cloudflare/workers-types.
type StepConfig = { retries?: { limit: number; delay: number | string } };
export type WorkflowStepLike = {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T>;
  waitForEvent(
    name: string,
    options: { type: string; timeout?: string | number },
  ): Promise<{ payload: unknown; type: string }>;
  sleep(name: string, duration: string | number): Promise<void>;
};
export type WorkflowBindingLike = {
  get(id: string): Promise<{
    sendEvent(event: { type: string; payload: unknown }): Promise<void>;
  }>;
};

export type ApproveOptions = ApprovalInput & {
  /** Step name prefix. Must be unique within the workflow. Default from action and resource. */
  name?: string;
  /** Called once with the approval link (link channel). Send it to the approvers. */
  notify?: (link: string, request: ApprovalRequest) => Promise<void> | void;
  config?: Partial<ApprovalConfig>;
  /**
   * Refused decisions (forged, replayed, wrong person) tolerated before the step gives
   * up. Each costs two steps, so this bounds what a flood of bad events can spend.
   * Default 25.
   */
  maxInvalid?: number;
  /** Re-check current authorization after proof verification, in its own step. */
  recheck?: (approval: Approval) => Promise<boolean>;
  /** Storage for unusually large approval requests. */
  store?: ApprovalStore;
  /** Resolve a single person when a push approver is named by role. */
  resolveApprover?: (request: ApprovalRequest) => Promise<string>;
};

/** The engine event type for one request. */
export const approvalEventType = (r: Pick<ApprovalRequest, "id">) =>
  `approval-${r.id.slice(4, 28)}`;

type Verdict =
  | { ok: true; approval: Approval }
  | { ok: false; code: ApprovalError["code"]; message: string };

/**
 * Waits for a verified decision. Returns the approval, or throws ApprovalRejected,
 * ApprovalExpired or ApprovalError. A forged or mismatched event is refused and the
 * step keeps waiting, so sending events can't approve and can't end the run.
 */
export async function approve(
  step: WorkflowStepLike,
  event: { instanceId: string },
  env: Record<string, unknown>,
  options: ApproveOptions,
): Promise<Approval> {
  const cfg = approvalConfig(env, options.config);
  const name = options.name ?? `approval ${options.action} ${options.resource}`;
  const { request } = await step.do(`${name}: request`, async () => {
    const request = await createApprovalRequest({
      ...options,
      run: event.instanceId,
      step: name,
    });
    if (request.via === "link")
      await options.notify?.(
        await approvalLink(cfg, request, options.store),
        request,
      );
    return { request };
  });
  const verify = async (i: number, proof: unknown): Promise<Verdict> => {
    const verdict = await step.do<Verdict>(`${name}: verify ${i}`, async () => {
      try {
        return {
          ok: true,
          approval: await verifyApproval(cfg, request, proof),
        };
      } catch (e) {
        // provider_error (keys unreachable) rethrows, so the engine retries the step.
        if (e instanceof ApprovalError && e.code !== "provider_error")
          return { ok: false, code: e.code, message: e.message };
        throw e;
      }
    });
    if (!verdict.ok || !options.recheck) return verdict;
    const current = await step.do(`${name}: recheck ${i}`, () =>
      options.recheck!(verdict.approval),
    );
    return current
      ? verdict
      : {
          ok: false,
          code: "not_an_approver",
          message:
            "The approver is no longer authorized to decide this request.",
        };
  };
  const settle = (v: Verdict & { ok: true }) => {
    if (v.approval.decision === "reject")
      throw new ApprovalRejected(v.approval);
    return v.approval;
  };

  if (request.via === "push") {
    const push = await step.do(`${name}: push`, () =>
      startPush(cfg, request, options.resolveApprover),
    );
    let interval = Math.max(5, push.interval);
    for (let i = 0; ; i++) {
      if (Date.now() / 1000 > request.exp)
        throw new ApprovalExpired(request.id);
      await step.sleep(`${name}: wait ${i}`, interval * 1000);
      const poll = await step.do(`${name}: poll ${i}`, () =>
        pollPush(cfg, push.authReqId),
      );
      if (poll.status === "pending") {
        interval = Math.max(interval, poll.interval ?? interval);
        continue;
      }
      if (poll.status === "denied")
        throw new ApprovalError(
          "rejected",
          "The approver declined on their device.",
        );
      if (poll.status === "expired") throw new ApprovalExpired(request.id);
      const v = await verify(0, poll.proof);
      if (!v.ok) throw new ApprovalError(v.code, v.message);
      return settle(v);
    }
  }

  const maxInvalid = options.maxInvalid ?? 25;
  for (let i = 0; i <= maxInvalid; i++) {
    const left = request.exp * 1000 - Date.now();
    if (left <= 0) throw new ApprovalExpired(request.id);
    let decision: { payload: unknown };
    try {
      decision = await step.waitForEvent(`${name}: decision ${i}`, {
        type: approvalEventType(request),
        timeout: left,
      });
    } catch (e) {
      if (Date.now() >= request.exp * 1000 - 1000)
        throw new ApprovalExpired(request.id);
      throw e;
    }
    const v = await verify(
      i,
      (decision.payload as { proof?: unknown } | null)?.proof,
    );
    if (v.ok) return settle(v);
  }
  throw new ApprovalError(
    "invalid_proof",
    `Gave up after ${maxInvalid + 1} decisions that failed verification.`,
  );
}

/** The approval page and Auth0 callback, delivering proofs to `workflow`. */
export function approvalRoutes(
  req: Request,
  env: Record<string, unknown>,
  options: Omit<ApprovalRoutesOptions, "deliver"> & {
    workflow: WorkflowBindingLike;
    config?: Partial<ApprovalConfig>;
  },
): Promise<Response | null> {
  return handleApprovalRoute(req, approvalConfig(env, options.config), {
    ...options,
    deliver: async ({ request, decision, proof }) => {
      const instance = await options.workflow.get(request.run);
      await instance.sendEvent({
        type: options.agentsSdk ? "approval" : approvalEventType(request),
        payload: options.agentsSdk
          ? { approved: decision === "approve", metadata: { proof } }
          : { proof },
      });
    },
  });
}
