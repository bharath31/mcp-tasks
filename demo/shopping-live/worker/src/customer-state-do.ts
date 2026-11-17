import { DurableObject } from "cloudflare:workers";
import type { ShoppingLiveEnv } from "./env.js";
import { MAX_CUSTOMER_SESSIONS } from "./env.js";

const BINDING_KEY = "nominee:bound_customer_id";
const BROWSER_SESSION_KEY = "nominee:browser_session_id";
const CART_KEY = "nominee:cart_id";
const SESSIONS_KEY = "nominee:sessions";
const AGENT_CAPS_KEY = "nominee:agent_capabilities";

type SessionRecord = {
  accessToken: string;
  expiresAtMs: number;
};

type AgentCapabilityRecord = {
  innerSid: string;
  digest: string;
  expiresAtMs: number;
};

type CustomerStateRpc =
  | { op: "bindCustomer"; customerId: string }
  | {
      op: "createSession";
      sid: string;
      accessToken: string;
      expiresAtMs: number;
    }
  | { op: "getSession"; sid: string }
  | { op: "revokeSession"; sid: string }
  | { op: "getCartId" }
  | { op: "setCartId"; cartId: string }
  | { op: "getBrowserSessionId" }
  | { op: "setBrowserSessionId"; browserSessionId: string }
  | {
      op: "putAgentCapability";
      runId: string;
      innerSid: string;
      digest: string;
      expiresAtMs: number;
    }
  | { op: "verifyAgentCapability"; runId: string; digest: string }
  | { op: "revokeAgentCapability"; runId: string }
  | { op: "revokeAgentCapabilitiesExcept"; keepRunId: string }
  | { op: "revokeAgentCapabilitiesForSession"; innerSid: string }
  | { op: "revokeAllAgentCapabilities" };

export class CustomerHostState extends DurableObject<ShoppingLiveEnv> {
  private sessionsLoaded = false;
  private sessions = new Map<string, SessionRecord>();
  private capsLoaded = false;
  private agentCaps = new Map<string, AgentCapabilityRecord>();

  private async loadSessions(): Promise<void> {
    if (this.sessionsLoaded) return;
    const stored = await this.ctx.storage.get<string>(SESSIONS_KEY);
    if (typeof stored === "string") {
      try {
        const parsed = JSON.parse(stored) as [string, SessionRecord][];
        this.sessions = new Map(parsed);
      } catch {
        this.sessions = new Map();
      }
    }
    this.sessionsLoaded = true;
  }

  private async persistSessions(): Promise<void> {
    await this.ctx.storage.put(
      SESSIONS_KEY,
      JSON.stringify([...this.sessions.entries()]),
    );
  }

  private async loadAgentCaps(): Promise<void> {
    if (this.capsLoaded) return;
    const stored = await this.ctx.storage.get<string>(AGENT_CAPS_KEY);
    if (typeof stored === "string") {
      try {
        const parsed = JSON.parse(stored) as [string, AgentCapabilityRecord][];
        this.agentCaps = new Map(parsed);
      } catch {
        this.agentCaps = new Map();
      }
    }
    this.capsLoaded = true;
  }

  private async persistAgentCaps(): Promise<void> {
    await this.ctx.storage.put(
      AGENT_CAPS_KEY,
      JSON.stringify([...this.agentCaps.entries()]),
    );
  }

  private pruneExpiredCaps(now: number): void {
    for (const [runId, rec] of this.agentCaps) {
      if (rec.expiresAtMs <= now) this.agentCaps.delete(runId);
    }
  }

  private async assertBinding(customerId: string): Promise<void> {
    const bound = await this.ctx.storage.get<string>(BINDING_KEY);
    if (!bound) {
      await this.ctx.storage.put(BINDING_KEY, customerId);
      return;
    }
    if (bound !== customerId) throw new Error("customer_binding_mismatch");
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let body: CustomerStateRpc;
    try {
      body = (await request.json()) as CustomerStateRpc;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    await this.loadSessions();
    await this.loadAgentCaps();
    const now = Date.now();
    try {
      const headerCustomer = request.headers.get("x-nominee-customer-id");
      if (body.op === "bindCustomer") {
        await this.assertBinding(body.customerId);
        return Response.json({ ok: true });
      }
      if (!headerCustomer) throw new Error("customer_binding_required");
      await this.assertBinding(headerCustomer);

      switch (body.op) {
        case "createSession": {
          for (const [sid, rec] of this.sessions) {
            if (rec.expiresAtMs <= now) this.sessions.delete(sid);
          }
          if (this.sessions.size >= MAX_CUSTOMER_SESSIONS) {
            return Response.json(
              { error: "session_capacity" },
              { status: 429 },
            );
          }
          this.sessions.set(body.sid, {
            accessToken: body.accessToken,
            expiresAtMs: body.expiresAtMs,
          });
          await this.persistSessions();
          return Response.json({ ok: true });
        }
        case "getSession": {
          const rec = this.sessions.get(body.sid);
          if (!rec || rec.expiresAtMs <= Date.now()) {
            return Response.json({ error: "session_missing" }, { status: 401 });
          }
          return Response.json({ accessToken: rec.accessToken });
        }
        case "revokeSession": {
          this.sessions.delete(body.sid);
          for (const [runId, cap] of this.agentCaps) {
            if (cap.innerSid === body.sid) this.agentCaps.delete(runId);
          }
          await this.persistSessions();
          await this.persistAgentCaps();
          return Response.json({ ok: true });
        }
        case "getCartId": {
          const cartId = (await this.ctx.storage.get<string>(CART_KEY)) ?? null;
          return Response.json({ cartId });
        }
        case "setCartId": {
          await this.ctx.storage.put(CART_KEY, body.cartId);
          return Response.json({ ok: true });
        }
        case "getBrowserSessionId": {
          let id = await this.ctx.storage.get<string>(BROWSER_SESSION_KEY);
          if (!id) {
            id = crypto.randomUUID();
            await this.ctx.storage.put(BROWSER_SESSION_KEY, id);
          }
          return Response.json({ browserSessionId: id });
        }
        case "setBrowserSessionId": {
          await this.ctx.storage.put(
            BROWSER_SESSION_KEY,
            body.browserSessionId,
          );
          return Response.json({ ok: true });
        }
        case "putAgentCapability": {
          this.pruneExpiredCaps(now);
          this.agentCaps.set(body.runId, {
            innerSid: body.innerSid,
            digest: body.digest,
            expiresAtMs: body.expiresAtMs,
          });
          await this.persistAgentCaps();
          return Response.json({ ok: true });
        }
        case "verifyAgentCapability": {
          this.pruneExpiredCaps(now);
          const rec = this.agentCaps.get(body.runId);
          if (!rec || rec.digest !== body.digest) {
            return Response.json(
              { error: "capability_invalid" },
              { status: 403 },
            );
          }
          if (rec.expiresAtMs <= now) {
            this.agentCaps.delete(body.runId);
            await this.persistAgentCaps();
            return Response.json(
              { error: "capability_expired" },
              { status: 401 },
            );
          }
          if (!this.sessions.has(rec.innerSid)) {
            return Response.json(
              { error: "parent_session_revoked" },
              { status: 401 },
            );
          }
          const session = this.sessions.get(rec.innerSid)!;
          if (session.expiresAtMs <= now) {
            return Response.json(
              { error: "parent_session_expired" },
              { status: 401 },
            );
          }
          return Response.json({
            innerSid: rec.innerSid,
            expiresAtMs: rec.expiresAtMs,
          });
        }
        case "revokeAgentCapability": {
          this.agentCaps.delete(body.runId);
          await this.persistAgentCaps();
          return Response.json({ ok: true });
        }
        case "revokeAgentCapabilitiesExcept": {
          for (const runId of this.agentCaps.keys()) {
            if (runId !== body.keepRunId) this.agentCaps.delete(runId);
          }
          await this.persistAgentCaps();
          return Response.json({ ok: true });
        }
        case "revokeAgentCapabilitiesForSession": {
          for (const [runId, cap] of this.agentCaps) {
            if (cap.innerSid === body.innerSid) this.agentCaps.delete(runId);
          }
          await this.persistAgentCaps();
          return Response.json({ ok: true });
        }
        case "revokeAllAgentCapabilities": {
          this.agentCaps.clear();
          await this.persistAgentCaps();
          return Response.json({ ok: true });
        }
        default:
          return Response.json({ error: "unknown_op" }, { status: 400 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "error";
      const status = message === "customer_binding_mismatch" ? 403 : 400;
      return Response.json({ error: message }, { status });
    }
  }
}

export async function customerStateRpc(
  stub: DurableObjectStub,
  customerId: string,
  body: CustomerStateRpc,
): Promise<Response> {
  return stub.fetch("http://customer-state/internal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nominee-customer-id": customerId,
    },
    body: JSON.stringify(body),
  });
}

export function customerStateStub(
  env: ShoppingLiveEnv,
  customerId: string,
): DurableObjectStub {
  return env.CUSTOMER_STATE.get(env.CUSTOMER_STATE.idFromName(customerId));
}
