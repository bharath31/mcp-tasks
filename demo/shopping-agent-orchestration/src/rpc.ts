import type { AgentRunCredential } from "./credential.js";
import type { PublicAgentRun, RunStatus } from "./types.js";
import type { PublicRunEvent } from "./types.js";

export type AgentRunRpc =
  | {
      op: "bindOwner";
      ownerId: string;
    }
  | {
      op: "createRun";
      runId: string;
      goal: string;
      parentInnerSid: string;
      credential: AgentRunCredential;
    }
  | {
      op: "verifyAndStart";
      runId: string;
      credential: AgentRunCredential;
    }
  | {
      op: "markRunning";
      runId: string;
      sessionId: string;
      credential: AgentRunCredential;
    }
  | {
      op: "appendEvents";
      runId: string;
      events: PublicRunEvent[];
      credential: AgentRunCredential;
    }
  | {
      op: "finishRun";
      runId: string;
      status: RunStatus;
      reply: string | null;
      credential: AgentRunCredential;
    }
  | {
      op: "getRun";
      runId: string;
    }
  | {
      op: "cleanupStale";
      nowMs: number;
      maxAgeMs: number;
      maxRunningAgeMs: number;
    };

export type AgentRunRpcResponse =
  | { ok: true; run?: PublicAgentRun; parentInnerSid?: string }
  | { ok: false; error: string };

export async function agentRunRpc(
  stub: DurableObjectStub,
  ownerId: string,
  body: AgentRunRpc,
): Promise<Response> {
  return stub.fetch("http://agent-runs/internal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nominee-owner-id": ownerId,
    },
    body: JSON.stringify(body),
  });
}

export function agentRunStub(
  env: { AGENT_RUNS: DurableObjectNamespace },
  ownerId: string,
): DurableObjectStub {
  return env.AGENT_RUNS.get(env.AGENT_RUNS.idFromName(ownerId));
}

export async function readAgentRunJson(
  res: Response,
): Promise<AgentRunRpcResponse> {
  const status = res.status;
  const body = (await res.json()) as AgentRunRpcResponse & { error?: string };
  if (status >= 400) {
    return { ok: false, error: body.error ?? `http_${status}` };
  }
  return body;
}