/**
 * Miniflare harness: merchant ledger + CIBA challenge store in one DO SqlStorage DB.
 */
import { DurableObject } from "cloudflare:workers";
import { buildGuardianPurchaseAuthorizationDetails } from "../../src/approval/guardian-transaction-details.js";
import { canonicalAuthorizationDetailsJson } from "../../src/ciba/canonical.js";
import { recordApprovalWithConsumedChallenge } from "../../src/ciba/ledger-bridge.js";
import { initCibaChallengeSchema } from "../../src/ciba/schema.js";
import { createSqlCibaChallengeStore } from "../../src/ciba/sql-ciba-challenge-store.js";
import { createMerchantLedger } from "../../src/ledger.js";
import { createDoSqlDatabase, initMerchantSchema } from "../../src/sql.js";
import type { AgentActor, HumanActor } from "../../src/types.js";
import {
  createFixtureCustomerAccount,
  createFixtureOrderProvider,
} from "../support/fixtures.js";

const CUSTOMER = "fixture-customer";
const MERCHANT = "Harness Shop";

const agent: AgentActor = {
  kind: "agent",
  customerId: CUSTOMER,
  agentId: "agent-do",
  pairwiseUserId: "user-do",
  sessionId: "sess-do",
  scopes: ["cart:write", "checkout:write", "addresses:read", "order:execute"],
};

const human: HumanActor = { kind: "human", customerId: CUSTOMER, scopes: [] };

function dbFor(ctx: DurableObjectState) {
  const db = createDoSqlDatabase(ctx.storage);
  initMerchantSchema(db);
  initCibaChallengeSchema(db);
  return db;
}

function ledgerFor(ctx: DurableObjectState) {
  const db = dbFor(ctx);
  return createMerchantLedger(
    db,
    {
      customerAccount: createFixtureCustomerAccount(),
      verifyCustomerApproval: async () => false,
      orderProvider: createFixtureOrderProvider(),
    },
    CUSTOMER,
  );
}

export class CibaLedgerHarness extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.searchParams.get("op");
    const nowMs = Number(url.searchParams.get("nowMs") ?? "0");
    const db = dbFor(this.ctx);
    const ledger = ledgerFor(this.ctx);

    if (op === "seed-quote") {
      const cart = ledger.createCart(agent);
      ledger.updateCart(cart.id, agent, [
        { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
      ]);
      const quote = await ledger.createQuote(cart.id, agent, "fixture-home");
      const boundQuote = {
        ...quote,
        expiresAt: new Date(nowMs + 15 * 60 * 1000).toISOString(),
      };
      db.exec(
        "UPDATE quotes SET data = ? WHERE id = ?",
        JSON.stringify(boundQuote),
        quote.id,
      );
      const store = createSqlCibaChallengeStore(db);
      const details = buildGuardianPurchaseAuthorizationDetails({
        quote: boundQuote,
        merchantDisplayName: MERCHANT,
        nowMs,
      });
      const challengeId = "chal-do-1";
      await store.insertStarting({
        id: challengeId,
        status: "starting",
        customerId: CUSTOMER,
        agentId: quote.agentId,
        sessionId: agent.sessionId,
        quoteId: quote.id,
        quoteRevision: quote.revision,
        operationId: quote.operationId,
        quoteExpiresAt: boundQuote.expiresAt,
        quoteSnapshot: structuredClone(boundQuote),
        canonicalAuthorizationDetailsJson:
          canonicalAuthorizationDetailsJson(details),
        authReqId: "auth-do",
        pollIntervalSec: 5,
        nextPollAtMs: nowMs,
        challengeExpiresAtMs: nowMs + 300_000,
        createdAtMs: nowMs,
        decidedAtMs: null,
        consumedAtMs: null,
        failureCode: null,
      });
      await store.transition(challengeId, ["starting"], "approved", {
        decidedAtMs: nowMs,
      });
      return Response.json({ quoteId: quote.id, challengeId });
    }

    if (op === "bridge-once") {
      const challengeId = url.searchParams.get("challengeId") ?? "chal-do-1";
      const quoteId = url.searchParams.get("quoteId");
      const record = db.exec("SELECT * FROM quotes WHERE id = ?", quoteId).one();
      if (!record) return Response.json({ ok: false, error: "no_quote" });
      const quote = JSON.parse(String(record.data));
      try {
        recordApprovalWithConsumedChallenge(
          db,
          CUSTOMER,
          { challengeId, quote, actor: human },
          { nowMs, merchantDisplayName: MERCHANT },
        );
        return Response.json({ ok: true });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "bridge_failed";
        return Response.json({ ok: false, error: message });
      }
    }

    if (op === "execute") {
      const quoteId = url.searchParams.get("quoteId");
      if (!quoteId) return Response.json({ status: "missing" });
      const result = await ledger.executeQuote(quoteId, agent);
      return Response.json(result);
    }

    return new Response("unknown", { status: 400 });
  }
}

export default {
  async fetch(request: Request, env: { CIBA_LEDGER: DurableObjectNamespace }) {
    const id = env.CIBA_LEDGER.idFromName("ciba-ledger");
    return env.CIBA_LEDGER.get(id).fetch(request);
  },
};