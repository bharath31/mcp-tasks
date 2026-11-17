/**
 * Miniflare harness: durable CIBA challenge store (createSqlCibaChallengeStore).
 */
import { DurableObject } from "cloudflare:workers";
import { createDoSqlDatabase } from "../../src/sql.js";
import { initCibaChallengeSchema } from "../../src/ciba/schema.js";
import { createSqlCibaChallengeStore } from "../../src/ciba/sql-ciba-challenge-store.js";
import type { PurchaseCibaChallenge } from "../../src/ciba/challenge-types.js";

function storeFor(ctx: DurableObjectState) {
  const db = createDoSqlDatabase(ctx.storage);
  initCibaChallengeSchema(db);
  return createSqlCibaChallengeStore(db);
}

function seedPollingChallenge(nowMs: number): PurchaseCibaChallenge {
  return {
    id: "chal-poll",
    status: "polling",
    customerId: "cust-1",
    agentId: "agent-1",
    sessionId: "sess-1",
    quoteId: "quote-1",
    quoteRevision: 1,
    operationId: "op-1",
    quoteExpiresAt: new Date("2099-01-01T00:00:00.000Z").toISOString(),
    quoteSnapshot: {
      id: "quote-1",
      operationId: "op-1",
      revision: 1,
      cartId: "cart-1",
      cartVersion: 1,
      customerId: "cust-1",
      agentId: "agent-1",
      items: [],
      subtotalMinor: 0,
      taxMinor: 0,
      shippingMinor: 0,
      totalMinor: 0,
      currency: "USD",
      destination: {
        id: "a",
        customerId: "cust-1",
        label: "Home",
        version: "1",
        trustedForAgentCheckout: true,
        destination: { country: "US" },
      },
      expiresAt: new Date("2099-01-01T00:00:00.000Z").toISOString(),
      requirement: "customer_verification",
    },
    canonicalAuthorizationDetailsJson: "{}",
    authReqId: "auth-req-1",
    pollIntervalSec: 1,
    nextPollAtMs: nowMs,
    challengeExpiresAtMs: nowMs + 300_000,
    createdAtMs: nowMs,
    decidedAtMs: null,
    consumedAtMs: null,
    failureCode: null,
  };
}

export class CibaChallengeHarness extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.searchParams.get("op");
    const store = storeFor(this.ctx);
    const nowMs = Number(url.searchParams.get("nowMs") ?? "0");

    if (op === "seed-polling") {
      const challenge = seedPollingChallenge(nowMs);
      await store.insertStarting({ ...challenge, status: "starting" });
      await store.transition(challenge.id, ["starting"], "polling", {
        authReqId: challenge.authReqId,
        nextPollAtMs: challenge.nextPollAtMs,
      });
      return Response.json({ id: challenge.id });
    }

    if (op === "claim-poll") {
      const id = url.searchParams.get("id") ?? "chal-poll";
      const claimed = await store.claimPoll(id, nowMs);
      return Response.json({ claimed: claimed !== null });
    }

    if (op === "seed-approved") {
      const challenge = seedPollingChallenge(nowMs);
      await store.insertStarting({ ...challenge, status: "starting" });
      await store.transition(challenge.id, ["starting"], "approved", {
        decidedAtMs: nowMs,
      });
      return Response.json({ id: challenge.id });
    }

    if (op === "consume") {
      const id = url.searchParams.get("id") ?? "chal-poll";
      const result = await store.consumeApproved(id, nowMs);
      return Response.json({
        ok: result.ok,
        reason: result.ok ? null : result.reason,
      });
    }

    if (op === "get-status") {
      const id = url.searchParams.get("id") ?? "chal-poll";
      const row = await store.get(id);
      return Response.json({
        status: row?.status ?? null,
        consumedAtMs: row?.consumedAtMs ?? null,
      });
    }

    return new Response("unknown", { status: 400 });
  }
}

export default {
  async fetch(request: Request, env: { CIBA_HARNESS: DurableObjectNamespace }) {
    const id = env.CIBA_HARNESS.idFromName("ciba-harness");
    return env.CIBA_HARNESS.get(id).fetch(request);
  },
};
