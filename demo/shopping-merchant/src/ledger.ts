import { catalogProduct } from "./catalog.js";
import {
  initMerchantSchema,
  type SqlDatabase,
  type SqlRow,
} from "./sql.js";

import { SERVER_CATALOG } from "./catalog.js";
import type {
  AgentActor,
  Cart,
  CartItem,
  CompletionResult,
  MerchantLedgerPorts,
  OrderSnapshot,
  Quote,
  TrustedActor,
  TrustedDestination,
  HumanActor,
} from "./types.js";

const fail = (): never => {
  throw new Error("not_found_or_forbidden");
};

function requireRow(row: SqlRow | null): SqlRow {
  if (!row) return fail();
  return row;
}

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const QUOTE_TTL_MS = 15 * 60 * 1000;

export function validateActor(actor: TrustedActor): void {
  if (
    !actor ||
    !["agent", "human"].includes(actor.kind) ||
    !Array.isArray(actor.scopes) ||
    !actor.scopes.every(nonempty)
  ) {
    fail();
  }
  if (actor.kind === "human") {
    if (!nonempty(actor.customerId)) fail();
    return;
  }
  if (
    !nonempty(actor.agentId) ||
    !nonempty(actor.pairwiseUserId) ||
    !nonempty(actor.sessionId) ||
    (actor.customerId !== undefined && !nonempty(actor.customerId))
  ) {
    fail();
  }
}

function randomId(): string {
  return crypto.randomUUID();
}

export type MerchantLedger = ReturnType<typeof createMerchantLedger>;

export function createMerchantLedger(
  db: SqlDatabase,
  ports: MerchantLedgerPorts,
  customerId: string,
) {
  if (!nonempty(customerId)) throw new Error("customer_id_required");
  initMerchantSchema(db);

  function getCartRow(id: string) {
    return db
      .exec("SELECT * FROM carts WHERE id = ? AND customer_id = ?", id, customerId)
      .one();
  }

  function authorizeCart(
    row: SqlRow | null,
    actor: TrustedActor,
    cartScope = true,
  ): asserts row is SqlRow {
    validateActor(actor);
    if (!row) return fail();
    if (actor.customerId !== row.customer_id) fail();
    if (actor.kind === "agent") {
      if (cartScope && !actor.scopes.includes("cart:write")) fail();
      if (
        row.agent_id &&
        (actor.agentId !== row.agent_id ||
          actor.pairwiseUserId !== row.pairwise_user_id)
      ) {
        fail();
      }
    }
  }

  function quoteActor(actor: TrustedActor): void {
    validateActor(actor);
    if (actor.kind === "agent") {
      if (
        !actor.scopes.includes("checkout:write") ||
        !actor.scopes.includes("addresses:read")
      ) {
        fail();
      }
    }
  }

  function activeExecution(cartId: string) {
    return db
      .exec(
        `SELECT e.* FROM checkout_executions e
         JOIN checkout_operations o ON o.operation_id = e.operation_id
         WHERE o.cart_id = ?`,
        cartId,
      )
      .one();
  }

  function cartView(row: SqlRow): Cart {
    return {
      id: row.id as string,
      version: row.version as number,
      items: JSON.parse(row.items as string) as CartItem[],
    };
  }

  function pricedItems(row: SqlRow): Quote["items"] {
    const items = JSON.parse(row.items as string) as {
      productId: string;
      quantity: number;
      priceMinor?: number;
      currency?: string;
    }[];
    if (!items.length) throw new Error("empty_cart");
    return items.map((item) => {
      const product = catalogProduct(item.productId);
      if (
        !product ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 100 ||
        item.priceMinor !== product.priceMinor ||
        item.currency !== product.currency
      ) {
        throw new Error("stale_cart_price");
      }
      return {
        productId: product.id,
        name: product.name,
        quantity: item.quantity,
        priceMinor: product.priceMinor,
        currency: product.currency,
      };
    });
  }

  function quoteView(data: string): Quote {
    return JSON.parse(data) as Quote;
  }

  async function resolveAddress(addressId: string): Promise<TrustedDestination> {
    const address = await ports.customerAccount.getAddress(customerId, addressId);
    if (
      !address ||
      address.id !== addressId ||
      address.customerId !== customerId ||
      !nonempty(address.id) ||
      !nonempty(address.label) ||
      !nonempty(address.version) ||
      typeof address.trustedForAgentCheckout !== "boolean" ||
      !address.destination ||
      typeof address.destination !== "object" ||
      Array.isArray(address.destination)
    ) {
      fail();
    }
    const trusted = address!;
    let destination: Record<string, unknown>;
    try {
      destination = JSON.parse(JSON.stringify(trusted.destination)) as Record<
        string,
        unknown
      >;
    } catch {
      throw new Error("invalid_address");
    }
    return {
      id: trusted.id,
      customerId: trusted.customerId,
      label: trusted.label,
      version: trusted.version,
      trustedForAgentCheckout: trusted.trustedForAgentCheckout,
      destination,
    };
  }

  return {
    catalog() {
      return SERVER_CATALOG.map((p) => ({ ...p }));
    },

    createCart(actor: TrustedActor) {
      validateActor(actor);
      if (actor.kind === "human") fail();
      const agent = actor as AgentActor;
      const id = randomId();
      db.exec(
        "INSERT INTO carts VALUES (?, ?, ?, ?, ?, 1, '[]')",
        id,
        customerId,
        agent.agentId,
        agent.pairwiseUserId,
        agent.sessionId,
      );
      return cartView(getCartRow(id)!);
    },

    readCart(cartId: string, actor: TrustedActor) {
      const row = getCartRow(cartId);
      authorizeCart(row, actor);
      return cartView(row!);
    },

    updateCart(cartId: string, actor: TrustedActor, items: CartItem[]) {
      if (!Array.isArray(items) || items.length > 50) throw new Error("invalid_items");
      const seen = new Set<string>();
      const priced: CartItem[] = items.map((item) => {
        if (
          !item ||
          !nonempty(item.productId) ||
          !Number.isSafeInteger(item.quantity) ||
          item.quantity < 1 ||
          item.quantity > 100 ||
          seen.has(item.productId)
        ) {
          throw new Error("invalid_items");
        }
        const product = catalogProduct(item.productId);
        if (!product) throw new Error("invalid_items");
        seen.add(item.productId);
        return {
          productId: product.id,
          quantity: item.quantity,
          priceMinor: product.priceMinor,
          currency: product.currency,
        };
      });
      return db.transaction(() => {
        const row = getCartRow(cartId);
        authorizeCart(row, actor);
        if (activeExecution(cartId)?.status === "processing") {
          throw new Error("checkout_processing");
        }
        db.exec(
          "UPDATE carts SET items = ?, version = version + 1 WHERE id = ? AND customer_id = ?",
          JSON.stringify(priced),
          cartId,
          customerId,
        );
        return cartView(getCartRow(cartId)!);
      });
    },

    async createQuote(
      cartId: string,
      actor: TrustedActor,
      shippingAddressId: string,
    ): Promise<Quote> {
      if (!nonempty(shippingAddressId)) throw new Error("invalid_address");
      const row = getCartRow(cartId);
      authorizeCart(row, actor, false);
      quoteActor(actor);
      const destination = await resolveAddress(shippingAddressId);

      return db.transaction(() => {
        const current = getCartRow(cartId);
        authorizeCart(current, actor, false);
        quoteActor(actor);
        const items = pricedItems(current!);
        const subtotalMinor = items.reduce(
          (sum, item) => sum + item.priceMinor * item.quantity,
          0,
        );
        if (!Number.isSafeInteger(subtotalMinor)) throw new Error("invalid_total");
        const taxMinor = 0;
        const shippingMinor = 0;
        const totalMinor = subtotalMinor;

        let op = db
          .exec("SELECT * FROM checkout_operations WHERE cart_id = ?", cartId)
          .one();
        const execution = activeExecution(cartId);
        if (execution?.status === "processing") throw new Error("checkout_processing");
        if (execution?.status === "completed" || execution?.status === "abandoned") {
          db.exec("DELETE FROM checkout_operations WHERE cart_id = ?", cartId);
          op = null;
        }
        if (!op) {
          const operationId = randomId();
          db.exec(
            "INSERT INTO checkout_operations VALUES (?, ?, 0)",
            cartId,
            operationId,
          );
          op = db
            .exec("SELECT * FROM checkout_operations WHERE cart_id = ?", cartId)
            .one()!;
        }
        const revision = (op.revision as number) + 1;
        db.exec(
          "UPDATE checkout_operations SET revision = ? WHERE cart_id = ?",
          revision,
          cartId,
        );
        const quote: Quote = {
          id: randomId(),
          operationId: op.operation_id as string,
          revision,
          cartId,
          cartVersion: current!.version as number,
          customerId,
          agentId: (current!.agent_id as string | null) ?? null,
          items,
          subtotalMinor,
          taxMinor,
          shippingMinor,
          totalMinor,
          currency: "USD",
          destination,
          expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
          requirement: "customer_verification",
        };
        db.exec(
          "INSERT INTO quotes VALUES (?, ?, ?, ?, ?)",
          quote.id,
          cartId,
          quote.operationId,
          revision,
          JSON.stringify(quote),
        );
        return quote;
      });
    },

    getQuote(quoteId: string, actor: TrustedActor): Quote {
      const record = requireRow(
        db.exec("SELECT * FROM quotes WHERE id = ?", quoteId).one(),
      );
      const row = getCartRow(record.cart_id as string);
      authorizeCart(row, actor, false);
      quoteActor(actor);
      return quoteView(record.data as string);
    },

    async validateQuote(quoteId: string, actor: TrustedActor): Promise<Quote> {
      const record = requireRow(
        db.exec("SELECT * FROM quotes WHERE id = ?", quoteId).one(),
      );
      const row = getCartRow(record.cart_id as string);
      authorizeCart(row, actor, false);
      quoteActor(actor);
      const quote = quoteView(record.data as string);
      if (quote.customerId !== customerId) fail();
      const address = await resolveAddress(quote.destination.id);
      const current = getCartRow(record.cart_id as string);
      authorizeCart(current, actor, false);
      const operation = db
        .exec("SELECT * FROM checkout_operations WHERE cart_id = ?", record.cart_id)
        .one();
      if (
        !operation ||
        operation.operation_id !== quote.operationId ||
        operation.revision !== quote.revision ||
        (current!.version as number) !== quote.cartVersion ||
        Date.now() >= Date.parse(quote.expiresAt) ||
        JSON.stringify(address) !== JSON.stringify(quote.destination) ||
        JSON.stringify(pricedItems(current!)) !== JSON.stringify(quote.items)
      ) {
        throw new Error("stale_quote");
      }
      return quote;
    },

    /**
     * Trusted-host-only approval injection. Fails closed when verifyCustomerApproval is absent or false.
     * There is no HTTP approve route; only the worker calls this after proof verification.
     */
    async injectCustomerApproval(quoteId: string, actor: HumanActor) {
      validateActor(actor);
      if (actor.kind !== "human") fail();
      if (typeof ports.verifyCustomerApproval !== "function") {
        throw new Error("customer_approval_unavailable");
      }
      const quote = await this.validateQuote(quoteId, actor);
      if (
        (await ports.verifyCustomerApproval({
          actor: structuredClone(actor),
          quote: structuredClone(quote),
        })) !== true
      ) {
        throw new Error("customer_approval_unverified");
      }
      await this.validateQuote(quoteId, actor);
      return db.transaction(() => {
        const record = requireRow(
          db.exec("SELECT * FROM quotes WHERE id = ?", quoteId).one(),
        );
        const row = getCartRow(record.cart_id as string);
        authorizeCart(row, actor, false);
        const current = quoteView(record.data as string);
        const operation = db
          .exec(
            "SELECT * FROM checkout_operations WHERE cart_id = ?",
            record.cart_id,
          )
          .one();
        if (
          !operation ||
          operation.operation_id !== quote.operationId ||
          operation.revision !== quote.revision ||
          current.id !== quote.id ||
          current.customerId !== actor.customerId ||
          (row!.version as number) !== quote.cartVersion ||
          Date.now() >= Date.parse(quote.expiresAt) ||
          JSON.stringify(current) !== JSON.stringify(quote) ||
          JSON.stringify(pricedItems(row!)) !== JSON.stringify(quote.items)
        ) {
          throw new Error("stale_quote");
        }
        db.exec(
          `INSERT OR IGNORE INTO quote_customer_approvals
           VALUES (?, ?, ?, ?, ?)`,
          quote.id,
          quote.operationId,
          quote.revision,
          quote.customerId,
          new Date().toISOString(),
        );
        return {
          status: "approval_recorded" as const,
          quoteId: quote.id,
          operationId: quote.operationId,
          revision: quote.revision,
        };
      });
    },

    async executeQuote(quoteId: string, actor: TrustedActor): Promise<CompletionResult> {
      validateActor(actor);
      quoteActor(actor);
      const record = requireRow(
        db.exec("SELECT * FROM quotes WHERE id = ?", quoteId).one(),
      );
      const cartRow = getCartRow(record.cart_id as string);
      authorizeCart(cartRow, actor, false);

      const existing = db
        .exec(
          "SELECT * FROM checkout_executions WHERE operation_id = ?",
          quoteView(record.data as string).operationId,
        )
        .one();
      if (existing) {
        if (
          existing.quote_id !== quoteId ||
          existing.customer_id !== customerId
        ) {
          fail();
        }
        if (existing.status === "completed") {
          return {
            status: "completed",
            order: JSON.parse(existing.order_data as string) as OrderSnapshot,
          };
        }
        if (existing.status === "abandoned") return { status: "abandoned" };
        return { status: "processing" };
      }

      let quote = await this.validateQuote(quoteId, actor);

      const approval = db
        .exec(
          `SELECT 1 AS ok FROM quote_customer_approvals
           WHERE quote_id = ? AND operation_id = ? AND revision = ? AND customer_id = ?`,
          quote.id,
          quote.operationId,
          quote.revision,
          quote.customerId,
        )
        .one();
      if (!approval) {
        return { status: "customer_verification_required" };
      }

      const claim = db.transaction(() => {
        const latest = requireRow(
          db.exec("SELECT * FROM quotes WHERE id = ?", quoteId).one(),
        );
        const row = getCartRow(latest.cart_id as string);
        authorizeCart(row, actor, false);
        quoteActor(actor);
        const current = quoteView(latest.data as string);
        const op = db
          .exec(
            "SELECT * FROM checkout_operations WHERE cart_id = ?",
            latest.cart_id,
          )
          .one();
        if (
          !op ||
          op.operation_id !== quote.operationId ||
          op.revision !== quote.revision ||
          (row!.version as number) !== quote.cartVersion ||
          Date.now() >= Date.parse(quote.expiresAt) ||
          JSON.stringify(current) !== JSON.stringify(quote) ||
          JSON.stringify(pricedItems(row!)) !== JSON.stringify(quote.items)
        ) {
          throw new Error("stale_quote");
        }
        const prior = db
          .exec(
            "SELECT * FROM checkout_executions WHERE operation_id = ?",
            quote.operationId,
          )
          .one();
        if (prior) {
          if (prior.quote_id !== quoteId || prior.customer_id !== customerId) fail();
          return { owner: false as const, row: prior };
        }
        if (
          !db
            .exec(
              `SELECT 1 AS ok FROM quote_customer_approvals
               WHERE quote_id = ? AND operation_id = ? AND revision = ? AND customer_id = ?`,
              quote.id,
              quote.operationId,
              quote.revision,
              quote.customerId,
            )
            .one()
        ) {
          throw new Error("approval_missing");
        }
        db.exec(
          `INSERT INTO checkout_executions
           VALUES (?, ?, ?, 'processing', ?, NULL)`,
          quote.operationId,
          quote.id,
          quote.customerId,
          quote.operationId,
        );
        return { owner: true as const, key: quote.operationId };
      });

      if (!claim.owner) {
        if (claim.row.status === "completed") {
          return {
            status: "completed",
            order: JSON.parse(claim.row.order_data as string) as OrderSnapshot,
          };
        }
        return { status: "processing" };
      }

      quote = await this.validateQuote(quoteId, actor);
      try {
        const placed = await ports.orderProvider.place({
          quote: structuredClone(quote),
          idempotencyKey: claim.key,
        });
        if (!placed || !nonempty(placed.id)) return { status: "processing" };
        const order: OrderSnapshot = {
          id: placed.id,
          customerId: quote.customerId,
          operationId: quote.operationId,
          quoteId: quote.id,
          totalMinor: quote.totalMinor,
          currency: quote.currency,
        };
        db.exec(
          `UPDATE checkout_executions
           SET status = 'completed', order_data = ?
           WHERE operation_id = ? AND status = 'processing'`,
          JSON.stringify(order),
          quote.operationId,
        );
        const saved = db
          .exec(
            "SELECT order_data FROM checkout_executions WHERE operation_id = ?",
            quote.operationId,
          )
          .one();
        return {
          status: "completed",
          order: JSON.parse(saved!.order_data as string) as OrderSnapshot,
        };
      } catch {
        return { status: "processing" };
      }
    },

    async reconcileQuote(quoteId: string, actor: TrustedActor): Promise<CompletionResult> {
      quoteActor(actor);
      const record = requireRow(
        db.exec("SELECT * FROM quotes WHERE id = ?", quoteId).one(),
      );
      authorizeCart(getCartRow(record.cart_id as string), actor, false);
      const quote = quoteView(record.data as string);
      const execution = db
        .exec(
          "SELECT * FROM checkout_executions WHERE operation_id = ? AND quote_id = ?",
          quote.operationId,
          quoteId,
        )
        .one();
      if (!execution) throw new Error("checkout_not_started");
      if (execution.status === "completed") {
        return {
          status: "completed",
          order: JSON.parse(execution.order_data as string) as OrderSnapshot,
        };
      }
      if (execution.status === "abandoned") return { status: "abandoned" };

      let order: { id: string; status?: "absent" } | null;
      try {
        order = await ports.orderProvider.reconcile({
          quote: structuredClone(quote),
          idempotencyKey: execution.provider_key as string,
        });
      } catch {
        return { status: "processing" };
      }
      if (order?.status === "absent") return { status: "provider_confirmed_absent" };
      if (!order || !nonempty(order.id)) return { status: "processing" };
      const snapshot: OrderSnapshot = {
        id: order.id,
        customerId: quote.customerId,
        operationId: quote.operationId,
        quoteId: quote.id,
        totalMinor: quote.totalMinor,
        currency: quote.currency,
      };
      db.exec(
        `UPDATE checkout_executions SET status = 'completed', order_data = ?
         WHERE operation_id = ? AND status = 'processing'`,
        JSON.stringify(snapshot),
        quote.operationId,
      );
      return { status: "completed", order: snapshot };
    },
  };
}