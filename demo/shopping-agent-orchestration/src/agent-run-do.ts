import { DurableObject } from "cloudflare:workers";
import {
  agentRunCredential,
  hashAgentRunCredential,
  type AgentRunCredential,
} from "./credential.js";
import { assertPublicEventsSafe } from "./run-events.js";
import type { AgentRunRpc } from "./rpc.js";
import type { PublicAgentRun, RunStatus } from "./types.js";
import type { PublicRunEvent } from "./types.js";

const OWNER_KEY = "nominee:agent_run_owner";
const RUNS_KEY = "nominee:agent_runs";
const MAX_EVENTS_PER_RUN = 200;
const MAX_RUNS_STORED = 32;

type RunRecord = {
  id: string;
  ownerId: string;
  goal: string;
  status: RunStatus;
  createdAtMs: number;
  updatedAtMs: number;
  sessionId: string | null;
  reply: string | null;
  credentialDigest: string;
  events: PublicRunEvent[];
};

function toPublic(run: RunRecord): PublicAgentRun {
  return {
    id: run.id,
    ownerId: run.ownerId,
    status: run.status,
    goal: run.goal,
    createdAtMs: run.createdAtMs,
    updatedAtMs: run.updatedAtMs,
    sessionId: run.sessionId,
    reply: run.reply,
    events: [...run.events],
  };
}

export class ShoppingAgentRunState extends DurableObject {
  private runsLoaded = false;
  private runs = new Map<string, RunRecord>();

  private async loadRuns(): Promise<void> {
    if (this.runsLoaded) return;
    const stored = await this.ctx.storage.get<string>(RUNS_KEY);
    if (typeof stored === "string") {
      try {
        const parsed = JSON.parse(stored) as [string, RunRecord][];
        this.runs = new Map(parsed);
      } catch {
        this.runs = new Map();
      }
    }
    this.runsLoaded = true;
  }

  private async persistRuns(): Promise<void> {
    await this.ctx.storage.put(
      RUNS_KEY,
      JSON.stringify([...this.runs.entries()]),
    );
  }

  private async assertOwner(ownerId: string): Promise<void> {
    const bound = await this.ctx.storage.get<string>(OWNER_KEY);
    if (!bound) {
      await this.ctx.storage.put(OWNER_KEY, ownerId);
      return;
    }
    if (bound !== ownerId) throw new Error("owner_binding_mismatch");
  }

  private getRunOrThrow(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new Error("run_not_found");
    return run;
  }

  private trimEvents(run: RunRecord): void {
    if (run.events.length > MAX_EVENTS_PER_RUN) {
      run.events = run.events.slice(-MAX_EVENTS_PER_RUN);
    }
  }

  private async verifyCredential(
    run: RunRecord,
    cred: AgentRunCredential,
  ): Promise<void> {
    const parsed = agentRunCredential.parse(cred);
    if (parsed.runId !== run.id || parsed.ownerId !== run.ownerId) {
      throw new Error("credential_scope_mismatch");
    }
    const digest = await hashAgentRunCredential(parsed);
    if (digest !== run.credentialDigest) {
      throw new Error("credential_invalid");
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const ownerHeader = request.headers.get("x-nominee-owner-id");
    if (!ownerHeader) {
      return Response.json({ ok: false, error: "owner_required" }, { status: 400 });
    }
    let body: AgentRunRpc;
    try {
      body = (await request.json()) as AgentRunRpc;
    } catch {
      return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }
    await this.loadRuns();
    try {
      if (body.op === "bindOwner") {
        await this.assertOwner(body.ownerId);
        if (body.ownerId !== ownerHeader) throw new Error("owner_header_mismatch");
        return Response.json({ ok: true });
      }
      await this.assertOwner(ownerHeader);

      switch (body.op) {
        case "createRun": {
          if (this.runs.size >= MAX_RUNS_STORED) {
            return Response.json(
              { ok: false, error: "run_capacity" },
              { status: 429 },
            );
          }
          const now = Date.now();
          const record: RunRecord = {
            id: body.runId,
            ownerId: ownerHeader,
            goal: body.goal,
            status: "pending",
            createdAtMs: now,
            updatedAtMs: now,
            sessionId: null,
            reply: null,
            credentialDigest: body.credentialDigest,
            events: [],
          };
          this.runs.set(body.runId, record);
          await this.persistRuns();
          return Response.json({ ok: true, run: toPublic(record) });
        }
        case "verifyAndStart": {
          const run = this.getRunOrThrow(body.runId);
          if (run.status !== "pending") {
            throw new Error("run_not_pending");
          }
          await this.verifyCredential(run, body.credential);
          run.status = "running";
          run.updatedAtMs = Date.now();
          await this.persistRuns();
          return Response.json({ ok: true, run: toPublic(run) });
        }
        case "markRunning": {
          const run = this.getRunOrThrow(body.runId);
          run.sessionId = body.sessionId;
          run.updatedAtMs = Date.now();
          await this.persistRuns();
          return Response.json({ ok: true, run: toPublic(run) });
        }
        case "appendEvents": {
          const run = this.getRunOrThrow(body.runId);
          assertPublicEventsSafe(body.events);
          run.events.push(...body.events);
          this.trimEvents(run);
          run.updatedAtMs = Date.now();
          await this.persistRuns();
          return Response.json({ ok: true, run: toPublic(run) });
        }
        case "finishRun": {
          const run = this.getRunOrThrow(body.runId);
          run.status = body.status;
          run.reply = body.reply ? body.reply.slice(0, 4000) : null;
          run.updatedAtMs = Date.now();
          await this.persistRuns();
          return Response.json({ ok: true, run: toPublic(run) });
        }
        case "getRun": {
          const run = this.getRunOrThrow(body.runId);
          return Response.json({ ok: true, run: toPublic(run) });
        }
        case "cleanupStale": {
          const cutoff = body.nowMs - body.maxAgeMs;
          for (const [id, run] of this.runs) {
            if (run.updatedAtMs < cutoff && run.status !== "running") {
              this.runs.delete(id);
            }
          }
          await this.persistRuns();
          return Response.json({ ok: true });
        }
        default:
          return Response.json({ ok: false, error: "unknown_op" }, { status: 400 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "error";
      const status =
        message === "owner_binding_mismatch"
          ? 403
          : message === "run_not_found"
            ? 404
            : 400;
      return Response.json({ ok: false, error: message }, { status });
    }
  }
}