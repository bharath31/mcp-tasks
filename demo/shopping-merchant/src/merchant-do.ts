/**
 * One Durable Object per customer holds the SQLite-backed merchant ledger,
 * CIBA challenge store, and fenced simulated wallet.
 */
import { DurableObject } from "cloudflare:workers";
import { ensureMerchantDemoShippingAddress } from "./customer-account/demo-address.js";
import {
  pollPurchaseCibaChallenge,
  startPurchaseCibaChallenge,
} from "./ciba/coordinator.js";
import { initCibaChallengeSchema } from "./ciba/schema.js";
import { createSqlCibaChallengeStore } from "./ciba/sql-ciba-challenge-store.js";
import { createMerchantLedger } from "./ledger.js";
import {
  createMerchantLedgerPorts,
  merchantDisplayNameFromEnv,
} from "./merchant-ports.js";
import {
  MERCHANT_HOST_INTERNAL_SECRET_HEADER,
  readHostInternalSecret,
  resolveSubrequestFetch,
  type MerchantLedgerEnv,
} from "./port-env.js";
import { createDoSqlDatabase, initMerchantSchema } from "./sql.js";
import { initializeTrustedSimulatedWalletOnce } from "./simulated-wallet/trusted-init.js";
import type { HumanActor, TrustedActor } from "./types.js";

const BOUND_CUSTOMER_KEY = "nominee:bound_customer_id";

type PublicRpcBody =
  | { op: "createCart"; actor: TrustedActor }
  | { op: "readCart"; actor: TrustedActor; cartId: string }
  | {
      op: "updateCart";
      actor: TrustedActor;
      cartId: string;
      items: {
        productId: string;
        quantity: number;
        priceMinor: number;
        currency: "USD";
      }[];
    }
  | {
      op: "createQuote";
      actor: TrustedActor;
      cartId: string;
      shippingAddressId: string;
    }
  | { op: "getQuote"; actor: TrustedActor; quoteId: string }
  | { op: "validateQuote"; actor: TrustedActor; quoteId: string }
  | {
      op: "setQuoteExpiresAtForTest";
      actor: TrustedActor;
      quoteId: string;
      expiresAt: string;
    }
  | { op: "executeQuote"; actor: TrustedActor; quoteId: string }
  | { op: "reconcileQuote"; actor: TrustedActor; quoteId: string }
  | { op: "abandonQuote"; actor: TrustedActor; quoteId: string }
  | {
      op: "startPurchaseCiba";
      actor: HumanActor;
      quoteId: string;
      browserSessionId: string | null;
      agentId: string | null;
    }
  | {
      op: "pollPurchaseCiba";
      actor: HumanActor;
      challengeId: string;
      quoteId: string;
      quoteRevision: number;
      operationId: string;
      browserSessionId: string | null;
      agentId: string | null;
    }
  | { op: "getCibaChallenge"; actor: HumanActor; challengeId: string };

type RpcBody =
  | PublicRpcBody
  | { op: "hostInjectCustomerApproval"; quoteId: string; actor: HumanActor }
  | { op: "injectCustomerApproval" };

export type { MerchantLedgerEnv };

export class CustomerMerchantLedger extends DurableObject<MerchantLedgerEnv> {
  private customerId: string | undefined;
  private ledger: ReturnType<typeof createMerchantLedger> | undefined;

  constructor(ctx: DurableObjectState, env: MerchantLedgerEnv) {
    super(ctx, env);
  }

  private database() {
    const db = createDoSqlDatabase(this.ctx.storage);
    initMerchantSchema(db);
    initCibaChallengeSchema(db);
    return db;
  }

  /**
   * Permanently bind this DO instance to the first authenticated customer id.
   * Seeds merchant demo address and simulated wallet once on first bind.
   */
  private assertCustomerBinding(customerId: string): void {
    const db = this.database();
    db.transaction(() => {
      const row = db
        .exec(
          "SELECT value FROM merchant_do_meta WHERE key = ?",
          BOUND_CUSTOMER_KEY,
        )
        .one();
      if (!row) {
        db.exec(
          "INSERT INTO merchant_do_meta VALUES (?, ?)",
          BOUND_CUSTOMER_KEY,
          customerId,
        );
        ensureMerchantDemoShippingAddress(db, customerId, this.env);
        initializeTrustedSimulatedWalletOnce(db, customerId);
        return;
      }
      if ((row.value as string) !== customerId) {
        throw new Error("customer_binding_mismatch");
      }
    });
  }

  private ledgerFor(customerId: string) {
    if (this.ledger && this.customerId === customerId) return this.ledger;
    this.customerId = customerId;
    const db = this.database();
    const ports = createMerchantLedgerPorts(db, customerId, this.env);
    this.ledger = createMerchantLedger(db, ports, customerId);
    return this.ledger;
  }

  private cibaStore() {
    return createSqlCibaChallengeStore(this.database());
  }

  private assertHumanActor(actor: HumanActor, customerId: string): void {
    if (
      !actor ||
      actor.kind !== "human" ||
      actor.customerId !== customerId ||
      !Array.isArray(actor.scopes)
    ) {
      throw new Error("not_found_or_forbidden");
    }
  }

  private hostSecretMatches(request: Request): boolean {
    const configured = readHostInternalSecret(this.env);
    if (!configured) return false;
    const presented = request.headers.get(MERCHANT_HOST_INTERNAL_SECRET_HEADER);
    return (
      presented !== null && presented.length > 0 && presented === configured
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }
    const customerId = request.headers.get("x-nominee-customer-id");
    if (!customerId) {
      return new Response(
        JSON.stringify({ error: "customer_binding_required" }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }

    let body: RpcBody;
    try {
      body = (await request.json()) as RpcBody;
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    if ((body as { op?: string }).op === "injectCustomerApproval") {
      return new Response(
        JSON.stringify({
          error: "customer_approval_host_only",
          detail:
            "Approval must be injected by the authenticated Worker via hostInjectCustomerApproval after independent proof; never from raw DO fetch actor JSON.",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }

    if (!readHostInternalSecret(this.env)) {
      return Response.json(
        {
          error: "merchant_host_unavailable",
          detail:
            "MERCHANT_HOST_INTERNAL_SECRET is not configured; DO ledger RPC stays disabled (fail-closed).",
        },
        { status: 503 },
      );
    }
    if (!this.hostSecretMatches(request)) {
      return Response.json(
        { error: "host_internal_forbidden" },
        { status: 403 },
      );
    }

    try {
      this.assertCustomerBinding(customerId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "customer_binding_mismatch";
      const status =
        message === "shipping_unconfigured"
          ? 503
          : message.includes("mismatch")
            ? 403
            : 409;
      return Response.json({ error: message }, { status });
    }

    try {
      if (body.op === "hostInjectCustomerApproval") {
        const ledger = this.ledgerFor(customerId);
        const result = await ledger.injectCustomerApproval(
          body.quoteId,
          body.actor,
        );
        return Response.json(result);
      }

      const subrequestFetch = resolveSubrequestFetch(this.env);

      if (body.op === "startPurchaseCiba") {
        this.assertHumanActor(body.actor, customerId);
        const ledger = this.ledgerFor(customerId);
        const quote = await ledger.validateQuote(body.quoteId, body.actor);
        const started = await startPurchaseCibaChallenge(
          {
            env: this.env,
            store: this.cibaStore(),
            fetch: subrequestFetch,
          },
          {
            customerId,
            agentId: body.agentId,
            sessionId: body.browserSessionId,
            quote,
            merchantDisplayName: merchantDisplayNameFromEnv(this.env),
            nowMs: Date.now(),
          },
        );
        return Response.json(started);
      }

      if (body.op === "getCibaChallenge") {
        this.assertHumanActor(body.actor, customerId);
        const row = await this.cibaStore().get(body.challengeId);
        if (!row || row.customerId !== customerId) {
          return Response.json(
            { error: "challenge_not_found" },
            { status: 404 },
          );
        }
        return Response.json({
          quoteId: row.quoteId,
          quoteRevision: row.quoteRevision,
          operationId: row.operationId,
          agentId: row.agentId,
          sessionId: row.sessionId,
          status: row.status,
          ...(row.failureCode ? { failureCode: row.failureCode } : {}),
        });
      }

      if (body.op === "pollPurchaseCiba") {
        this.assertHumanActor(body.actor, customerId);
        const ledger = this.ledgerFor(customerId);
        await ledger.validateQuote(body.quoteId, body.actor);
        const polled = await pollPurchaseCibaChallenge(
          {
            env: this.env,
            store: this.cibaStore(),
            fetch: subrequestFetch,
          },
          {
            challengeId: body.challengeId,
            quoteId: body.quoteId,
            quoteRevision: body.quoteRevision,
            operationId: body.operationId,
            customerId,
            agentId: body.agentId,
            sessionId: body.browserSessionId,
          },
        );
        if (polled.status === "approved") {
          const quote = ledger.getQuote(body.quoteId, body.actor);
          const stored = await this.cibaStore().get(body.challengeId);
          const approvalRecorded = ledger.hasCustomerApprovalForQuote(quote);
          if (stored?.consumedAtMs != null || approvalRecorded) {
            if (!approvalRecorded) {
              throw new Error("challenge_already_consumed");
            }
            return Response.json(polled);
          }
          try {
            const bridged = ledger.recordCustomerApprovalFromCibaChallenge(
              body.challengeId,
              body.actor,
              quote,
              { merchantDisplayName: merchantDisplayNameFromEnv(this.env) },
            );
            return Response.json({ ...polled, ledger: bridged });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "bridge_failed";
            if (
              message === "challenge_already_consumed" &&
              ledger.hasCustomerApprovalForQuote(quote)
            ) {
              return Response.json(polled);
            }
            throw error;
          }
        }
        return Response.json(polled);
      }

      if (body.op === "setQuoteExpiresAtForTest") {
        if (this.env.SHOPPING_LEDGER_TEST_HOOKS !== "1") {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        const ledger = this.ledgerFor(customerId);
        const quote = ledger.setQuoteExpiresAtForTest(
          body.quoteId,
          body.actor,
          body.expiresAt,
        );
        return Response.json(quote);
      }

      const ledger = this.ledgerFor(customerId);
      let result: unknown;
      switch (body.op) {
        case "createCart":
          result = ledger.createCart(body.actor);
          break;
        case "readCart":
          result = ledger.readCart(body.cartId, body.actor);
          break;
        case "updateCart":
          result = ledger.updateCart(body.cartId, body.actor, body.items);
          break;
        case "createQuote":
          result = await ledger.createQuote(
            body.cartId,
            body.actor,
            body.shippingAddressId,
          );
          break;
        case "getQuote":
          result = ledger.getQuote(body.quoteId, body.actor);
          break;
        case "validateQuote":
          result = await ledger.validateQuote(body.quoteId, body.actor);
          break;
        case "executeQuote":
          result = await ledger.executeQuote(body.quoteId, body.actor);
          break;
        case "reconcileQuote":
          result = await ledger.reconcileQuote(body.quoteId, body.actor);
          break;
        case "abandonQuote":
          result = await ledger.abandonQuote(body.quoteId, body.actor);
          break;
        default:
          return new Response(JSON.stringify({ error: "unknown_op" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
      }
      return Response.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "error";
      const status =
        message === "not_found_or_forbidden"
          ? 403
          : message === "merchant_ports_unconfigured" ||
              message === "shipping_unconfigured"
            ? 503
            : 409;
      return Response.json({ error: message }, { status });
    }
  }
}
