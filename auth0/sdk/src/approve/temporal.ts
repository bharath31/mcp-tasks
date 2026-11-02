// Temporal adapter. Workflow code only installs a signal handler, waits, and
// chooses; request creation, token verification and role lookups run in activities.
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

export const TEMPORAL_APPROVAL_SIGNAL = "auth0ApprovalDecision";
/** Structural subset of Temporal's SignalDefinition returned by defineSignal(). */
export type TemporalSignalDefinitionLike = {
  name: string;
  typeInfo?: unknown;
};
export type TemporalDecisionSignal = { proof: unknown };
export type TemporalVerification =
  | { ok: true; approval: Approval }
  | { ok: false; code: ApprovalError["code"]; message: string };

export type TemporalWorkflowRuntimeLike = {
  setHandler(
    signal: TemporalSignalDefinitionLike,
    handler: (value: TemporalDecisionSignal) => void,
  ): void;
  condition(predicate: () => boolean, timeoutMs: number): Promise<boolean>;
};

export type TemporalApprovalActivities = {
  request(
    input: ApprovalInput & { run: string; step: string },
  ): Promise<ApprovalRequest>;
  verify(
    request: ApprovalRequest,
    proof: unknown,
  ): Promise<TemporalVerification>;
  recheck?(approval: Approval): Promise<boolean>;
};

export type TemporalClientLike = {
  workflow: {
    getHandle(id: string): {
      signal(name: string, value: TemporalDecisionSignal): Promise<void>;
    };
  };
};

export type TemporalApproveOptions = ApprovalInput & {
  name?: string;
  /** `defineSignal<[TemporalDecisionSignal]>(TEMPORAL_APPROVAL_SIGNAL)` from @temporalio/workflow. */
  signal: TemporalSignalDefinitionLike;
  maxInvalid?: number;
  recheck?: boolean;
  config?: Partial<ApprovalConfig>;
  notify?: (link: string, request: ApprovalRequest) => Promise<void> | void;
  store?: ApprovalStore;
};

/** Build activity implementations outside the workflow sandbox. */
export function createTemporalApprovalActivities(
  env: Record<string, unknown>,
  options: Pick<TemporalApproveOptions, "config" | "notify" | "store"> & {
    recheck?: (approval: Approval) => Promise<boolean>;
  } = {},
): TemporalApprovalActivities {
  const cfg = approvalConfig(env, options.config);
  return {
    request: async (input) => {
      const request = await createApprovalRequest(input);
      if (request.via !== "link")
        throw new ApprovalError(
          "invalid_request",
          "Temporal approvals currently support the link channel only.",
        );
      await options.notify?.(
        await approvalLink(cfg, request, options.store),
        request,
      );
      return request;
    },
    verify: async (request, proof) => {
      try {
        return {
          ok: true,
          approval: await verifyApproval(cfg, request, proof),
        };
      } catch (e) {
        if (e instanceof ApprovalError && e.code !== "provider_error")
          return { ok: false, code: e.code, message: e.message };
        throw e;
      }
    },
    ...(options.recheck ? { recheck: options.recheck } : {}),
  };
}

/** Waits on a Temporal signal and verifies each proof in an activity. */
export async function approveTemporal(
  runtime: TemporalWorkflowRuntimeLike,
  activities: TemporalApprovalActivities,
  runId: string,
  options: TemporalApproveOptions,
): Promise<Approval> {
  const name = options.name ?? `approval ${options.action} ${options.resource}`;
  const {
    signal,
    name: _name,
    maxInvalid: _maxInvalid,
    recheck: _recheck,
    config: _config,
    notify: _notify,
    store: _store,
    ...input
  } = options;
  const request = await activities.request({
    ...input,
    run: runId,
    step: name,
  });
  const proofs: unknown[] = [];
  runtime.setHandler(signal, (decision) => {
    proofs.push(decision?.proof);
  });
  const maxInvalid = options.maxInvalid ?? 25;
  for (let i = 0; i <= maxInvalid; i++) {
    const leftMs = request.exp * 1000 - Date.now();
    if (
      leftMs <= 0 ||
      !(await runtime.condition(() => proofs.length > 0, leftMs))
    )
      throw new ApprovalExpired(request.id);
    const proof = proofs.shift();
    const verdict = await activities.verify(request, proof);
    if (!verdict.ok) continue;
    const approval = verdict.approval;
    if (options.recheck && activities.recheck) {
      if (!(await activities.recheck(approval))) continue;
    }
    if (approval.decision === "reject") throw new ApprovalRejected(approval);
    return approval;
  }
  throw new ApprovalError(
    "invalid_proof",
    `Gave up after ${maxInvalid + 1} decisions that failed verification.`,
  );
}

/** The approval page callback signals the workflow with the proof only. */
export function temporalApprovalRoutes(
  req: Request,
  env: Record<string, unknown>,
  options: Omit<ApprovalRoutesOptions, "deliver"> & {
    client: TemporalClientLike;
    config?: Partial<ApprovalConfig>;
  },
): Promise<Response | null> {
  return handleApprovalRoute(req, approvalConfig(env, options.config), {
    ...options,
    deliver: async ({ request, proof }) => {
      await options.client.workflow
        .getHandle(request.run)
        .signal(TEMPORAL_APPROVAL_SIGNAL, { proof });
    },
  });
}
