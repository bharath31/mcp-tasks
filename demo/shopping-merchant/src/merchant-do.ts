/**
 * One Durable Object per customer holds the SQLite-backed merchant ledger.
 * SqlStorage transactions provide atomic claim/approval/execution state.
 */
import { DurableObject } from "cloudflare:workers";
import { createMerchantLedger } from "./ledger.js";
import { createDoSqlDatabase } from "./sql.js";
import type { MerchantLedgerPorts } from "./types.js";
import type { TrustedActor, HumanActor } from "./types.js";

export type MerchantLedgerEnv = {
  /** Host-injected ports are wired by the Worker bundle, not from request bodies. */
  MERCHANT_PORTS?: MerchantLedgerPorts;
};

type RpcBody =
  | { op: "createCart"; actor: TrustedActor }
  | { op: "readCart"; actor: TrustedActor; cartId: string }
  | {
      op: "updateCart";
      actor: TrustedActor;
      cartId: string;
      items: { productId: string; quantity: number; priceMinor: number; currency: "USD" }[];
    }
  | { op: "createQuote"; actor: TrustedActor; cartId: string; shippingAddressId: string }
  | { op: "getQuote"; actor: TrustedActor; quoteId: string }
  | { op: "injectCustomerApproval"; actor: HumanActor; quoteId: string }
  | { op: "executeQuote"; actor: TrustedActor; quoteId: string }
  | { op: "reconcileQuote"; actor: TrustedActor; quoteId: string };

export class CustomerMerchantLedger extends DurableObject<MerchantLedgerEnv> {
  private customerId: string | undefined;
  private ledger: ReturnType<typeof createMerchantLedger> | undefined;

  constructor(ctx: DurableObjectState, env: MerchantLedgerEnv) {
    super(ctx, env);
  }

  private ports(): MerchantLedgerPorts {
    const ports = this.env.MERCHANT_PORTS;
    if (!ports?.customerAccount || !ports.verifyCustomerApproval || !ports.orderProvider) {
      throw new Error("merchant_ports_unconfigured");
    }
    return ports;
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

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }
    const customerId = request.headers.get("x-nominee-customer-id");
    if (!customerId) {
      return new Response(JSON.stringify({ error: "customer_binding_required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
  // Internal RPC only: the Worker must authenticate before forwarding.
    let body: RpcBody;
    try {
      body = (await request.json()) as RpcBody;
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const ledger = this.ledgerFor(customerId);
    try {
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
        case "injectCustomerApproval":
          result = await ledger.injectCustomerApproval(body.quoteId, body.actor);
          break;
        case "executeQuote":
          result = await ledger.executeQuote(body.quoteId, body.actor);
          break;
        case "reconcileQuote":
          result = await ledger.reconcileQuote(body.quoteId, body.actor);
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
      const status = message === "not_found_or_forbidden" ? 403 : 409;
      return Response.json({ error: message }, { status });
    }
  }
}