// Vercel Workflow SDK adapter. Inject the SDK primitives so applications that
// don't use Vercel don't have to install the Workflow SDK.
import {
  ApprovalError,
  ApprovalExpired,
  ApprovalRejected,
  approvalConfig,
  approvalLink,
  createApprovalRequest,
  verifyApproval,
  type Approval,
  type ApprovalConfig,
  type ApprovalInput,
  type ApprovalRequest,
  type ApprovalStore,
} from "./core.js";
import { handleApprovalRoute, type ApprovalRoutesOptions } from "./routes.js";

export type VercelHook<T> = AsyncIterable<T>;
export type VercelWorkflowApi = {
  createHook<T>(options: { token: string }): VercelHook<T>;
  sleep(duration: string | number): Promise<void>;
  resumeHook(token: string, value: { proof: unknown }): Promise<void>;
};

export type VercelApproveOptions = ApprovalInput & {
  name?: string;
  maxInvalid?: number;
  notify?: (link: string, request: ApprovalRequest) => Promise<void> | void;
  recheck?: (approval: Approval) => Promise<boolean>;
  config?: Partial<ApprovalConfig>;
  store?: ApprovalStore;
};

/** Creates a signed request and waits for verified resumeHook payloads. */
export async function approveVercel(
  api: Pick<VercelWorkflowApi, "createHook" | "sleep">,
  runId: string,
  env: Record<string, unknown>,
  options: VercelApproveOptions,
): Promise<Approval> {
  const cfg = approvalConfig(env, options.config);
  const name = options.name ?? `approval ${options.action} ${options.resource}`;
  const request = await createApprovalRequest({
    ...options,
    run: runId,
    step: name,
  });
  if (request.via !== "link")
    throw new ApprovalError(
      "invalid_request",
      "Vercel approvals currently support the link channel only.",
    );
  await options.notify?.(
    await approvalLink(cfg, request, options.store),
    request,
  );
  const hook = api.createHook<{ proof: unknown }>({ token: request.id });
  const iterator = hook[Symbol.asyncIterator]();
  const maxInvalid = options.maxInvalid ?? 25;
  const remaining = Math.max(0, request.exp - Math.floor(Date.now() / 1000));
  const timeout = api.sleep(`${remaining}s`).then(() => ({
    expired: true as const,
  }));
  try {
    for (let i = 0; i <= maxInvalid; i++) {
      const next = await Promise.race([
        iterator.next().then((result) => ({ expired: false as const, result })),
        timeout,
      ]);
      if (next.expired || next.result.done)
        throw new ApprovalExpired(request.id);
      let approval: Approval;
      try {
        approval = await verifyApproval(cfg, request, next.result.value?.proof);
      } catch (e) {
        if (e instanceof ApprovalError && e.code !== "provider_error") continue;
        throw e;
      }
      if (options.recheck && !(await options.recheck(approval))) continue;
      if (approval.decision === "reject") throw new ApprovalRejected(approval);
      return approval;
    }
  } finally {
    await iterator.return?.();
  }
  throw new ApprovalError(
    "invalid_proof",
    `Gave up after ${maxInvalid + 1} decisions that failed verification.`,
  );
}

/** The approval page callback resumes a hook with the proof only. */
export function vercelApprovalRoutes(
  req: Request,
  env: Record<string, unknown>,
  options: Omit<ApprovalRoutesOptions, "deliver"> & {
    api: Pick<VercelWorkflowApi, "resumeHook">;
    config?: Partial<ApprovalConfig>;
  },
): Promise<Response | null> {
  return handleApprovalRoute(req, approvalConfig(env, options.config), {
    ...options,
    deliver: async ({ request, proof }) => {
      await options.api.resumeHook(request.id, { proof });
    },
  });
}
