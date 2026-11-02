// Inngest's durable steps and waitForEvent, with the same proof checks as the
// Cloudflare adapter. This file uses structural types to keep Inngest optional.
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

export type InngestStepLike = {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, duration: string | number): Promise<void>;
  waitForEvent(
    id: string,
    options: { event: string; if: string; timeout: string },
  ): Promise<{ data?: unknown } | null>;
};

export type InngestClientLike = {
  send(event: {
    name: string;
    data: Record<string, unknown>;
  }): Promise<unknown>;
};

export type InngestApproveOptions = ApprovalInput & {
  name?: string;
  notify?: (link: string, request: ApprovalRequest) => Promise<void> | void;
  config?: Partial<ApprovalConfig>;
  store?: ApprovalStore;
  maxInvalid?: number;
  recheck?: (approval: Approval) => Promise<boolean>;
  resolveApprover?: (request: ApprovalRequest) => Promise<string>;
};

const EVENT = "auth0/approval.decided";

/** Waits for an Inngest event carrying a valid, request-bound proof. */
export async function approveInngest(
  step: InngestStepLike,
  runId: string,
  env: Record<string, unknown>,
  options: InngestApproveOptions,
): Promise<Approval> {
  const cfg = approvalConfig(env, options.config);
  const name = options.name ?? `approval ${options.action} ${options.resource}`;
  const request = await step.run(`${name}: request`, async () => {
    const request = await createApprovalRequest({
      ...options,
      run: runId,
      step: name,
    });
    if (request.via === "link")
      await options.notify?.(
        await approvalLink(cfg, request, options.store),
        request,
      );
    return request;
  });

  const verify = async (index: number, proof: unknown) => {
    const verdict = await step.run(`${name}: verify ${index}`, async () => {
      try {
        return {
          ok: true as const,
          approval: await verifyApproval(cfg, request, proof),
        };
      } catch (e) {
        if (e instanceof ApprovalError && e.code !== "provider_error")
          return { ok: false as const };
        throw e;
      }
    });
    if (!verdict.ok || !options.recheck) return verdict;
    const current = await step.run(`${name}: recheck ${index}`, () =>
      options.recheck!(verdict.approval),
    );
    return current ? verdict : { ok: false as const };
  };
  const settle = (approval: Approval) => {
    if (approval.decision === "reject") throw new ApprovalRejected(approval);
    return approval;
  };

  if (request.via === "push") {
    const push = await step.run(`${name}: push`, () =>
      startPush(cfg, request, options.resolveApprover),
    );
    let interval = Math.max(5, push.interval);
    for (let i = 0; ; i++) {
      if (Date.now() / 1000 > request.exp)
        throw new ApprovalExpired(request.id);
      await step.sleep(`${name}: wait ${i}`, `${interval}s`);
      const poll = await step.run(`${name}: poll ${i}`, () =>
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
      const verdict = await verify(0, poll.proof);
      if (!verdict.ok)
        throw new ApprovalError(
          "invalid_proof",
          "The push carried an invalid proof.",
        );
      return settle(verdict.approval);
    }
  }

  const maxInvalid = options.maxInvalid ?? 25;
  for (let i = 0; i <= maxInvalid; i++) {
    const left = request.exp - Math.floor(Date.now() / 1000);
    if (left <= 0) throw new ApprovalExpired(request.id);
    const event = await step.waitForEvent(`${name}: decision ${i}`, {
      event: EVENT,
      if: `async.data.requestId == '${request.id}'`,
      timeout: `${left}s`,
    });
    if (!event) throw new ApprovalExpired(request.id);
    const proof = (event.data as { proof?: unknown } | undefined)?.proof;
    const verdict = await verify(i, proof);
    if (verdict.ok) return settle(verdict.approval);
  }
  throw new ApprovalError(
    "invalid_proof",
    `Gave up after ${maxInvalid + 1} decisions that failed verification.`,
  );
}

/** The approval page callback publishes a request-specific Inngest event. */
export function inngestApprovalRoutes(
  req: Request,
  env: Record<string, unknown>,
  options: Omit<ApprovalRoutesOptions, "deliver"> & {
    inngest: InngestClientLike;
    config?: Partial<ApprovalConfig>;
  },
): Promise<Response | null> {
  return handleApprovalRoute(req, approvalConfig(env, options.config), {
    ...options,
    deliver: async ({ request, proof }) => {
      await options.inngest.send({
        name: EVENT,
        data: { requestId: request.id, proof },
      });
    },
  });
}
