/**
 * One Durable Object per customer holds the SQLite-backed merchant ledger.
 * SqlStorage transactions provide atomic claim/approval/execution state.
 */
import { DurableObject } from "cloudflare:workers";
import { createMerchantLedger } from "./ledger.js";
import {
  MERCHANT_HOST_INTERNAL_SECRET_HEADER,
  merchantLedgerPortsFromEnv,
  readHostInternalSecret,
  type MerchantLedgerEnv,
} from "./port-env.js";
import { createDoSqlDatabase, initMerchantSchema } from "./sql.js";
import type { TrustedActor } from "./types.js";
import type { HumanActor } from "./types.js";

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
  | { op: "executeQuote"; actor: TrustedActor; quoteId: string }
  | { op: "reconcileQuote"; actor: TrustedActor; quoteId: string }
  | { op: "abandonQuote"; actor: TrustedActor; quoteId: string };

type RpcBody =
  | PublicRpcBody
  | { op: "hostInjectCustomerApproval"; quoteId: string; actor: HumanActor }
  | { op: "injectCustomerApproval" };

export type { MerchantLedgerEnv };

export class CustomerMerchantLedger extends DurableObject<MerchantLedgerEnv> {
  private customerId: string | undefined;
  private ledger: ReturnType<typeof createMerchantLedger> | undefined;
  private portsCache: ReturnType<typeof merchantLedgerPortsFromEnv> | undefined;

  constructor(ctx: DurableObjectState, env: MerchantLedgerEnv) {
    super(ctx, env);
  }

  private ports() {
    if (!this.portsCache) {
      this.portsCache = merchantLedgerPortsFromEnv(this.env);
    }
    return this.portsCache;
  }

  /**
   * Permanently bind this DO instance to the first authenticated customer id.
   * Rejects a later request that presents a different header value (including after isolate restart).
   */
  private assertCustomerBinding(customerId: string): void {
    const db = createDoSqlDatabase(this.ctx.storage);
    initMerchantSchema(db);
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
    this.ledger = createMerchantLedger(
      createDoSqlDatabase(this.ctx.storage),
      this.ports(),
      customerId,
    );
    return this.ledger;
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

    // Raw JSON actors are not authenticated on this surface; Worker must verify identity before forward.
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
      return Response.json({ error: message }, { status: 403 });
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
          : message === "merchant_ports_unconfigured"
            ? 503
            : 409;
      return Response.json({ error: message }, { status });
    }
  }
}
