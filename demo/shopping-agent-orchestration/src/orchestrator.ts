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
  hashAgentRunCredential,
  mintAgentRunCredential,
  type AgentRunCredential,
} from "./credential.js";
import { shoppingEventToPublic } from "./run-events.js";
import {
  agentRunRpc,
  agentRunStub,
  readAgentRunJson,
} from "./rpc.js";
import type {
  PublicAgentRun,
  RunPortsFactory,
  ShoppingAgentOrchestrationEnv,
  StartRunInput,
} from "./types.js";

export const DEFAULT_PRODUCTION_PORTS: RunPortsFactory = ({ config, env }) => ({
  model: createWorkersAiModel(env.AI),
  launchBrowser: createPuppeteerLauncher(env.BROWSER, config),
});

export type OrchestrationBlockers = {
  /** Authenticated storefront session cookies are not injected into Browser Run yet. */
  browserAuthenticatedSession: string;
};

export const ORCHESTRATION_BLOCKERS: OrchestrationBlockers = {
  browserAuthenticatedSession:
    "createPuppeteerLauncher opens an isolated Browser Run session with merchant guardrails only. It does not propagate the customer's host session cookie or OAuth access token into the browser. Signed-in cart sync from the agent requires a host-defined cookie bootstrap (not implemented in shopping-agent or this module).",
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
  const digest = await hashAgentRunCredential(cred);
  const res = await agentRunRpc(stub, input.ownerId, {
    op: "createRun",
    runId: cred.runId,
    goal: input.goal.trim(),
    credentialDigest: digest,
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

  const startRes = await agentRunRpc(stub, opts.ownerId, {
    op: "verifyAndStart",
    runId: cred.runId,
    credential: cred,
  });
  const started = await readAgentRunJson(startRes);
  if (!started.ok) throw new Error(started.error);

  const portsFactory = opts.ports ?? DEFAULT_PRODUCTION_PORTS;
  const { model, launchBrowser } = portsFactory({ config, env: opts.env });
  const now = opts.now ?? Date.now;
  const pendingEvents: ReturnType<typeof shoppingEventToPublic>[] = [];

  const flushEvents = async (events: ShoppingAgentEvent[]) => {
    const mapped = events.map((e) => shoppingEventToPublic(e, now()));
    pendingEvents.push(...mapped);
    if (!mapped.length) return;
    await agentRunRpc(stub, opts.ownerId, {
      op: "appendEvents",
      runId: cred.runId,
      events: mapped,
    });
  };

  const buffer: ShoppingAgentEvent[] = [];
  let markedSession = false;
  const emit = (e: ShoppingAgentEvent) => {
    if (e.type === "session_start" && !markedSession) {
      markedSession = true;
      void agentRunRpc(stub, opts.ownerId, {
        op: "markRunning",
        runId: cred.runId,
        sessionId: e.sessionId,
      });
    }
    buffer.push(e);
    if (buffer.length >= 4) {
      void flushEvents(buffer.splice(0, buffer.length));
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

  if (buffer.length) await flushEvents(buffer.splice(0, buffer.length));

  const status: import("./types.js").RunStatus =
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
    reply: result.reply,
  });
  const finished = await readAgentRunJson(finishRes);
  if (!finished.ok || !finished.run) {
    const err = finished.ok ? "finish_failed" : finished.error;
    throw new Error(err);
  }
  return finished.run;
}

export async function cleanupStaleAgentRuns(
  env: ShoppingAgentOrchestrationEnv,
  ownerId: string,
  nowMs: number,
  maxAgeMs: number,
): Promise<void> {
  await agentRunRpc(agentRunStub(env, ownerId), ownerId, {
    op: "cleanupStale",
    nowMs,
    maxAgeMs,
  });
}