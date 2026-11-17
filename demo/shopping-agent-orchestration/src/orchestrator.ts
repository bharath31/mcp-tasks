import {
  createPuppeteerLauncher,
  createWorkersAiModel,
  runShoppingAgent,
  shoppingAgentConfig,
  shoppingRequest,
  type ShoppingAgentConfig,
  type ShoppingAgentEvent,
} from "@nominee/shopping-agent";
import {
  mintAgentRunCredential,
  type AgentRunCredential,
} from "./credential.js";
import { shoppingEventToPublic } from "./run-events.js";
import { sanitizePublicText } from "./sanitize.js";
import { agentRunRpc, agentRunStub, readAgentRunJson } from "./rpc.js";
import type { BrowserInitCookie } from "@nominee/shopping-agent";
import type {
  PublicAgentRun,
  RunPortsFactory,
  RunStatus,
  ShoppingAgentOrchestrationEnv,
  StartRunInput,
} from "./types.js";

export const DEFAULT_PRODUCTION_PORTS: RunPortsFactory = ({ config, env }) => ({
  model: createWorkersAiModel(env.AI),
  launchBrowser: createPuppeteerLauncher(env.BROWSER, config),
});

export function createAgentCapabilityPorts(
  capabilityCookies: BrowserInitCookie[],
): RunPortsFactory {
  return ({ config, env }) => {
    const base = DEFAULT_PRODUCTION_PORTS({ config, env });
    const innerLaunch = createPuppeteerLauncher(env.BROWSER, config);
    return {
      model: base.model,
      launchBrowser: async (opts) =>
        innerLaunch({
          ...opts,
          agentCartApiOnly: true,
          initCookies: capabilityCookies,
        }),
    };
  };
}

export const DEFAULT_MAX_RUNNING_AGE_MS = 30 * 60 * 1000;

export type OrchestrationBlockers = {
  /** Host must mint short-lived agent-browser capability cookies; never copy customer session/JWT. */
  browserAuthenticatedSession: string;
};

export const ORCHESTRATION_BLOCKERS: OrchestrationBlockers = {
  browserAuthenticatedSession:
    "Signed-in agent cart sync is implemented by shopping-live via host-minted agent capability cookies injected into Browser Run only. Customer session cookies and OAuth tokens must never be copied into the model or browser.",
};

export function resolveOrchestrationConfig(
  env: ShoppingAgentOrchestrationEnv,
  partial?: Partial<ShoppingAgentConfig>,
): ShoppingAgentConfig {
  return shoppingAgentConfig.parse({
    merchantOrigin: env.MERCHANT_ORIGIN,
    model: env.AGENT_MODEL,
    ...partial,
  });
}

export type PreparedRun = {
  credential: AgentRunCredential;
  /** Host returns this to the client once; it must not appear in run events. */
  credentialEnvelope: string;
};

export async function prepareShoppingAgentRun(
  env: ShoppingAgentOrchestrationEnv,
  input: StartRunInput,
): Promise<PreparedRun> {
  shoppingRequest.parse({ goal: input.goal });
  const cred = mintAgentRunCredential(input.ownerId);
  const stub = agentRunStub(env, input.ownerId);
  const res = await agentRunRpc(stub, input.ownerId, {
    op: "createRun",
    runId: cred.runId,
    goal: input.goal.trim(),
    credential: cred,
  });
  const parsed = await readAgentRunJson(res);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    credential: cred,
    credentialEnvelope: btoa(JSON.stringify(cred)),
  };
}

export async function getShoppingAgentRun(
  env: ShoppingAgentOrchestrationEnv,
  ownerId: string,
  runId: string,
): Promise<PublicAgentRun | null> {
  const res = await agentRunRpc(agentRunStub(env, ownerId), ownerId, {
    op: "getRun",
    runId,
  });
  const parsed = await readAgentRunJson(res);
  if (!parsed.ok) return null;
  return parsed.run ?? null;
}

async function finishAgentRunFailed(
  stub: DurableObjectStub,
  ownerId: string,
  credential: AgentRunCredential,
  reply: string,
): Promise<PublicAgentRun | null> {
  const secrets = [credential.secret];
  const finishRes = await agentRunRpc(stub, ownerId, {
    op: "finishRun",
    runId: credential.runId,
    status: "failed",
    reply: sanitizePublicText(reply, 4000, secrets),
    credential,
  });
  const finished = await readAgentRunJson(finishRes);
  return finished.ok && finished.run ? finished.run : null;
}

export async function executeShoppingAgentRun(opts: {
  env: ShoppingAgentOrchestrationEnv;
  ownerId: string;
  credential: AgentRunCredential;
  goal: string;
  configPartial?: Partial<ShoppingAgentConfig>;
  ports?: RunPortsFactory;
  now?: () => number;
}): Promise<PublicAgentRun> {
  const config = resolveOrchestrationConfig(opts.env, opts.configPartial);
  const stub = agentRunStub(opts.env, opts.ownerId);
  const cred = opts.credential;
  const secrets = [cred.secret];
  const now = opts.now ?? Date.now;
  let executionStarted = false;
  const buffer: ShoppingAgentEvent[] = [];
  let flushEventsImpl:
    ((events: ShoppingAgentEvent[]) => Promise<void>) | null = null;

  let persistenceTail: Promise<void> = Promise.resolve();
  const queuePersistence = (work: () => Promise<void>): void => {
    persistenceTail = persistenceTail.then(work, work);
  };

  const drainPersistence = async (): Promise<void> => {
    await persistenceTail;
  };

  try {
    const startRes = await agentRunRpc(stub, opts.ownerId, {
      op: "verifyAndStart",
      runId: cred.runId,
      credential: cred,
    });
    const started = await readAgentRunJson(startRes);
    if (!started.ok) throw new Error(started.error);
    executionStarted = true;

    flushEventsImpl = async (events: ShoppingAgentEvent[]) => {
      const mapped = events.map((e) =>
        shoppingEventToPublic(e, now(), secrets),
      );
      if (!mapped.length) return;
      const res = await agentRunRpc(stub, opts.ownerId, {
        op: "appendEvents",
        runId: cred.runId,
        events: mapped,
        credential: cred,
      });
      const parsed = await readAgentRunJson(res);
      if (!parsed.ok) throw new Error(parsed.error);
    };

    const portsFactory = opts.ports ?? DEFAULT_PRODUCTION_PORTS;
    const { model, launchBrowser } = portsFactory({ config, env: opts.env });
    let markedSession = false;
    const emit = (e: ShoppingAgentEvent) => {
      if (e.type === "session_start" && !markedSession) {
        markedSession = true;
        queuePersistence(async () => {
          const res = await agentRunRpc(stub, opts.ownerId, {
            op: "markRunning",
            runId: cred.runId,
            sessionId: e.sessionId,
            credential: cred,
          });
          const parsed = await readAgentRunJson(res);
          if (!parsed.ok) throw new Error(parsed.error);
        });
      }
      buffer.push(e);
      if (buffer.length >= 4) {
        const batch = buffer.splice(0, buffer.length);
        queuePersistence(() => flushEventsImpl!(batch));
      }
    };

    const result = await runShoppingAgent({
      config,
      request: { goal: opts.goal },
      model,
      launchBrowser,
      sessionId: cred.runId,
      now,
      emit,
    });

    if (buffer.length) {
      queuePersistence(() => flushEventsImpl!(buffer.splice(0, buffer.length)));
    }
    await drainPersistence();

    const status: RunStatus =
      result.status === "completed"
        ? "completed"
        : result.status === "stopped"
          ? "stopped"
          : result.status === "budget_exhausted"
            ? "budget_exhausted"
            : "failed";

    const finishRes = await agentRunRpc(stub, opts.ownerId, {
      op: "finishRun",
      runId: cred.runId,
      status,
      reply: sanitizePublicText(result.reply ?? "", 4000, secrets),
      credential: cred,
    });
    const finished = await readAgentRunJson(finishRes);
    if (!finished.ok || !finished.run) {
      const err = finished.ok ? "finish_failed" : finished.error;
      throw new Error(err);
    }
    return finished.run;
  } catch (error) {
    if (executionStarted) {
      if (buffer.length && flushEventsImpl) {
        queuePersistence(() =>
          flushEventsImpl!(buffer.splice(0, buffer.length)),
        );
      }
      await drainPersistence();
      const message =
        error instanceof Error ? error.message : "execution_failed";
      const leaked = cred.secret;
      const safeMessage = sanitizePublicText(message, 4000, [leaked]);
      const failedRun = await finishAgentRunFailed(
        stub,
        opts.ownerId,
        cred,
        safeMessage,
      );
      if (failedRun) return failedRun;
    }
    throw error;
  }
}

export async function cleanupStaleAgentRuns(
  env: ShoppingAgentOrchestrationEnv,
  ownerId: string,
  nowMs: number,
  maxAgeMs: number,
  maxRunningAgeMs = DEFAULT_MAX_RUNNING_AGE_MS,
): Promise<void> {
  await agentRunRpc(agentRunStub(env, ownerId), ownerId, {
    op: "cleanupStale",
    nowMs,
    maxAgeMs,
    maxRunningAgeMs,
  });
}
