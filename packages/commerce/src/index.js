import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Domain-only implementation; callers must supply trusted authentication and adapters.
const products = Object.freeze([
  Object.freeze({
    id: "mug",
    name: "Mug",
    description: "Ceramic mug",
    priceMinor: 1800,
    currency: "USD",
  }),
  Object.freeze({
    id: "tea",
    name: "Tea",
    description: "Loose leaf tea",
    priceMinor: 1200,
    currency: "USD",
  }),
]);
const fail = () => {
  throw new Error("not_found_or_forbidden");
};
const nonempty = (value) => typeof value === "string" && value.length > 0;

/** Actor values MUST come from a trusted verifier, never from request JSON. */
function validateActor(actor) {
  if (
    !actor ||
    !["agent", "human"].includes(actor.kind) ||
    !Array.isArray(actor.scopes) ||
    !actor.scopes.every(nonempty)
  )
    fail();
  if (actor.kind === "human") {
    if (!nonempty(actor.customerId)) fail();
  } else if (
    !nonempty(actor.agentId) ||
    !nonempty(actor.pairwiseUserId) ||
    !nonempty(actor.sessionId) ||
    (actor.customerId !== undefined && !nonempty(actor.customerId))
  )
    fail();
}

/** Single-host SQLite cart ledger. Close it when the application shuts down. */
export function createCartStore(path, options = {}) {
  if (!nonempty(path)) throw new Error("database_path_required");
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS carts (
      id TEXT PRIMARY KEY, customer_id TEXT, agent_id TEXT, pairwise_user_id TEXT,
      session_id TEXT, version INTEGER NOT NULL, items TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkout_operations (
      cart_id TEXT PRIMARY KEY REFERENCES carts(id), operation_id TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY, cart_id TEXT NOT NULL REFERENCES carts(id),
      operation_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
      UNIQUE(operation_id, revision)
    );
    CREATE TABLE IF NOT EXISTS quote_human_reviews (
      quote_id TEXT PRIMARY KEY REFERENCES quotes(id),
      operation_id TEXT NOT NULL, revision INTEGER NOT NULL,
      customer_id TEXT NOT NULL, reviewed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkout_executions (
      operation_id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE,
      customer_id TEXT NOT NULL, status TEXT NOT NULL, provider_key TEXT NOT NULL UNIQUE,
      order_data TEXT
    );`);
  const get = db.prepare("SELECT * FROM carts WHERE id = ?");
  function authorize(row, actor, cartScope = true) {
    validateActor(actor);
    if (!row) fail();
    if (row.customer_id) {
      if (actor.customerId !== row.customer_id) fail();
      if (
        actor.kind === "agent" &&
        ((cartScope && !actor.scopes.includes("cart:write")) ||
          actor.agentId !== row.agent_id ||
          actor.pairwiseUserId !== row.pairwise_user_id)
      )
        fail();
    } else if (
      actor.kind !== "agent" ||
      actor.customerId !== undefined ||
      actor.agentId !== row.agent_id ||
      actor.pairwiseUserId !== row.pairwise_user_id ||
      actor.sessionId !== row.session_id
    )
      fail();
  }
  function activeExecution(cartId) {
    return db
      .prepare(
        `SELECT e.* FROM checkout_executions e JOIN checkout_operations o
      ON o.operation_id = e.operation_id WHERE o.cart_id = ?`,
      )
      .get(cartId);
  }
  function view(row) {
    return { id: row.id, version: row.version, items: JSON.parse(row.items) };
  }
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const getQuoteRow = db.prepare("SELECT * FROM quotes WHERE id = ?");
  function quoteActor(row, actor) {
    authorize(row, actor, false);
    if (!row.customer_id) fail();
    if (
      actor.kind === "agent" &&
      (!actor.scopes.includes("checkout:write") ||
        !actor.scopes.includes("addresses:read"))
    )
      fail();
  }
  function executionActor(quote, actor) {
    const cart = get.get(quote.cartId);
    quoteActor(cart, actor);
    if (cart.agent_id && actor.kind !== "agent") fail();
  }
  async function addressFor(customerId, addressId) {
    const port = options.customerAccount;
    if (!port || typeof port.getAddress !== "function")
      throw new Error("customer_account_unavailable");
    const address = await port.getAddress(customerId, addressId);
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
    )
      fail();
    // A JSON snapshot excludes live references and functions from a trusted adapter.
    let destination;
    try {
      destination = JSON.parse(JSON.stringify(address.destination));
    } catch {
      throw new Error("invalid_address");
    }
    if (
      !destination ||
      typeof destination !== "object" ||
      Array.isArray(destination)
    )
      throw new Error("invalid_address");
    return {
      id: address.id,
      customerId: address.customerId,
      label: address.label,
      version: address.version,
      trustedForAgentCheckout: address.trustedForAgentCheckout,
      destination,
    };
  }
  function pricedItems(row) {
    const items = JSON.parse(row.items);
    if (!items.length) throw new Error("empty_cart");
    return items.map((item) => {
      const product = products.find((p) => p.id === item.productId);
      if (
        !product ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 100 ||
        item.priceMinor !== product.priceMinor ||
        item.currency !== product.currency
      )
        throw new Error("stale_cart_price");
      return {
        productId: product.id,
        name: product.name,
        quantity: item.quantity,
        priceMinor: product.priceMinor,
        currency: product.currency,
      };
    });
  }
  function quoteView(q) {
    return JSON.parse(q.data);
  }
  return {
    catalog: () => products.map((product) => ({ ...product })),
    create(actor) {
      validateActor(actor);
      if (
        actor.kind === "agent" &&
        actor.customerId &&
        !actor.scopes.includes("cart:write")
      )
        fail();
      const id = randomUUID();
      db.prepare("INSERT INTO carts VALUES (?, ?, ?, ?, ?, 1, '[]')").run(
        id,
        actor.customerId ?? null,
        actor.agentId ?? null,
        actor.pairwiseUserId ?? null,
        actor.sessionId ?? null,
      );
      return view(get.get(id));
    },
    read(id, actor) {
      const row = get.get(id);
      authorize(row, actor);
      return view(row);
    },
    update(id, actor, items) {
      if (!Array.isArray(items) || items.length > 50)
        throw new Error("invalid_items");
      const seen = new Set();
      const priced = items.map((item) => {
        if (
          !item ||
          Object.keys(item).sort().join(",") !== "productId,quantity" ||
          !Number.isSafeInteger(item.quantity) ||
          item.quantity < 1 ||
          item.quantity > 100 ||
          seen.has(item.productId)
        )
          throw new Error("invalid_items");
        const product = products.find((p) => p.id === item.productId);
        if (!product) throw new Error("invalid_items");
        seen.add(item.productId);
        return {
          productId: product.id,
          quantity: item.quantity,
          priceMinor: product.priceMinor,
          currency: product.currency,
        };
      });
      return transaction(() => {
        const row = get.get(id);
        authorize(row, actor);
        if (activeExecution(id)?.status === "processing")
          throw new Error("checkout_processing");
        db.prepare(
          "UPDATE carts SET items = ?, version = version + 1 WHERE id = ?",
        ).run(JSON.stringify(priced), id);
        return view(get.get(id));
      });
    },
    link(id, actor) {
      validateActor(actor);
      if (
        actor.kind !== "agent" ||
        !actor.customerId ||
        !actor.scopes.includes("cart:write")
      )
        fail();
      return transaction(() => {
        const row = get.get(id);
        if (
          !row ||
          row.agent_id !== actor.agentId ||
          row.pairwise_user_id !== actor.pairwiseUserId ||
          row.session_id !== actor.sessionId ||
          (row.customer_id && row.customer_id !== actor.customerId)
        )
          fail();
        if (!row.customer_id)
          db.prepare(
            "UPDATE carts SET customer_id = ?, version = version + 1 WHERE id = ? AND customer_id IS NULL",
          ).run(actor.customerId, id);
        return view(get.get(id));
      });
    },
    async createQuote(cartId, actor, shippingAddressId) {
      if (!nonempty(shippingAddressId)) throw new Error("invalid_address");
      let row = get.get(cartId);
      quoteActor(row, actor);
      const customerId = row.customer_id;
      const address = await addressFor(customerId, shippingAddressId);
      return transaction(() => {
        row = get.get(cartId);
        quoteActor(row, actor);
        if (row.customer_id !== customerId) fail();
        const items = pricedItems(row);
        const subtotalMinor = items.reduce(
          (sum, item) => sum + item.priceMinor * item.quantity,
          0,
        );
        if (!Number.isSafeInteger(subtotalMinor))
          throw new Error("invalid_total");
        const taxMinor = 0,
          shippingMinor = 0,
          totalMinor = subtotalMinor;
        let op = db
          .prepare("SELECT * FROM checkout_operations WHERE cart_id = ?")
          .get(cartId);
        const execution = activeExecution(cartId);
        if (execution?.status === "processing")
          throw new Error("checkout_processing");
        if (execution?.status === "completed") {
          db.prepare("DELETE FROM checkout_operations WHERE cart_id = ?").run(
            cartId,
          );
          op = undefined;
        }
        if (!op) {
          db.prepare("INSERT INTO checkout_operations VALUES (?, ?, 0)").run(
            cartId,
            randomUUID(),
          );
          op = db
            .prepare("SELECT * FROM checkout_operations WHERE cart_id = ?")
            .get(cartId);
        }
        const previous = op.revision
          ? db
              .prepare(
                "SELECT data FROM quotes WHERE operation_id = ? AND revision = ?",
              )
              .get(op.operation_id, op.revision)
          : null;
        const changedDestination =
          previous &&
          JSON.stringify(JSON.parse(previous.data).destination) !==
            JSON.stringify(address);
        const revision = op.revision + 1;
        db.prepare(
          "UPDATE checkout_operations SET revision = ? WHERE cart_id = ?",
        ).run(revision, cartId);
        const quote = {
          id: randomUUID(),
          operationId: op.operation_id,
          revision,
          cartId,
          cartVersion: row.version,
          customerId,
          items,
          subtotalMinor,
          taxMinor,
          shippingMinor,
          totalMinor,
          currency: "USD",
          destination: address,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          requirement:
            totalMinor <= 5000 &&
            address.trustedForAgentCheckout &&
            !changedDestination
              ? "agent_confirmation"
              : "customer_verification",
        };
        db.prepare("INSERT INTO quotes VALUES (?, ?, ?, ?, ?)").run(
          quote.id,
          cartId,
          op.operation_id,
          revision,
          JSON.stringify(quote),
        );
        return quote;
      });
    },
    getQuote(id, actor) {
      const quote = getQuoteRow.get(id);
      if (!quote) fail();
      quoteActor(get.get(quote.cart_id), actor);
      return quoteView(quote);
    },
    async validateQuote(id, actor) {
      const record = getQuoteRow.get(id);
      if (!record) fail();
      let row = get.get(record.cart_id);
      quoteActor(row, actor);
      const quote = quoteView(record);
      const address = await addressFor(quote.customerId, quote.destination.id);
      row = get.get(record.cart_id);
      quoteActor(row, actor);
      const operation = db
        .prepare("SELECT * FROM checkout_operations WHERE cart_id = ?")
        .get(record.cart_id);
      if (
        !operation ||
        operation.operation_id !== quote.operationId ||
        operation.revision !== quote.revision ||
        row.version !== quote.cartVersion ||
        row.customer_id !== quote.customerId ||
        Date.now() >= Date.parse(quote.expiresAt) ||
        JSON.stringify(address) !== JSON.stringify(quote.destination) ||
        JSON.stringify(pricedItems(row)) !== JSON.stringify(quote.items)
      )
        throw new Error("stale_quote");
      return quote;
    },
    async completeQuote(id, actor) {
      const authority = options.authorization;
      const provider = options.orderProvider;
      if (
        !authority ||
        typeof authority.evaluate !== "function" ||
        !provider ||
        typeof provider.place !== "function" ||
        typeof provider.reconcile !== "function"
      )
        throw new Error("checkout_adapters_unavailable");
      let quote = await this.validateQuote(id, actor);
      executionActor(quote, actor);
      const existing = db
        .prepare("SELECT * FROM checkout_executions WHERE operation_id = ?")
        .get(quote.operationId);
      if (existing) {
        if (
          existing.quote_id !== id ||
          existing.customer_id !== actor.customerId
        )
          fail();
        return existing.status === "completed"
          ? { status: "completed", order: JSON.parse(existing.order_data) }
          : { status: "processing" };
      }
      const decision = await authority.evaluate({
        actor: structuredClone(actor),
        quote: structuredClone(quote),
      });
      if (
        !["agent_confirmation", "customer_verification", "denied"].includes(
          decision,
        )
      )
        throw new Error("invalid_authorization_decision");
      if (decision === "denied") return { status: "denied" };
      const needsHuman =
        actor.kind === "human" ||
        quote.requirement === "customer_verification" ||
        decision === "customer_verification";
      if (needsHuman) {
        const review = db
          .prepare(
            "SELECT * FROM quote_human_reviews WHERE quote_id = ? AND operation_id = ? AND revision = ? AND customer_id = ?",
          )
          .get(quote.id, quote.operationId, quote.revision, quote.customerId);
        if (!review) return { status: "customer_verification_required" };
      } else {
        if (
          typeof options.verifyAgentConfirmation !== "function" ||
          (await options.verifyAgentConfirmation({
            actor: structuredClone(actor),
            quote: structuredClone(quote),
          })) !== true
        )
          return { status: "approval_required" };
      }
      quote = await this.validateQuote(id, actor);
      const claim = transaction(() => {
        const record = getQuoteRow.get(id);
        const row = record && get.get(record.cart_id);
        quoteActor(row, actor);
        const op = db
          .prepare("SELECT * FROM checkout_operations WHERE cart_id = ?")
          .get(record.cart_id);
        if (
          !op ||
          op.operation_id !== quote.operationId ||
          op.revision !== quote.revision ||
          row.version !== quote.cartVersion ||
          Date.now() >= Date.parse(quote.expiresAt) ||
          JSON.stringify(quoteView(record)) !== JSON.stringify(quote) ||
          JSON.stringify(pricedItems(row)) !== JSON.stringify(quote.items)
        )
          throw new Error("stale_quote");
        const prior = db
          .prepare("SELECT * FROM checkout_executions WHERE operation_id = ?")
          .get(quote.operationId);
        if (prior) {
          if (prior.quote_id !== id || prior.customer_id !== actor.customerId)
            fail();
          return { owner: false, row: prior };
        }
        if (
          needsHuman &&
          !db
            .prepare(
              "SELECT 1 FROM quote_human_reviews WHERE quote_id = ? AND operation_id = ? AND revision = ? AND customer_id = ?",
            )
            .get(quote.id, quote.operationId, quote.revision, quote.customerId)
        )
          throw new Error("review_missing");
        db.prepare(
          "INSERT INTO checkout_executions VALUES (?, ?, ?, 'processing', ?, NULL)",
        ).run(quote.operationId, quote.id, quote.customerId, quote.operationId);
        return { owner: true, key: quote.operationId };
      });
      if (!claim.owner)
        return claim.row.status === "completed"
          ? { status: "completed", order: JSON.parse(claim.row.order_data) }
          : { status: "processing" };
      try {
        const order = await provider.place({
          quote: structuredClone(quote),
          idempotencyKey: claim.key,
        });
        if (!order || !nonempty(order.id)) return { status: "processing" };
        const data = JSON.stringify({
          id: order.id,
          customerId: quote.customerId,
          operationId: quote.operationId,
          quoteId: quote.id,
          totalMinor: quote.totalMinor,
          currency: quote.currency,
        });
        db.prepare(
          "UPDATE checkout_executions SET status = 'completed', order_data = ? WHERE operation_id = ? AND status = 'processing'",
        ).run(data, quote.operationId);
        const saved = db
          .prepare(
            "SELECT order_data FROM checkout_executions WHERE operation_id = ?",
          )
          .get(quote.operationId);
        return { status: "completed", order: JSON.parse(saved.order_data) };
      } catch {
        return { status: "processing" };
      }
    },
    async reconcileQuote(id, actor) {
      const provider = options.orderProvider;
      if (!provider || typeof provider.reconcile !== "function")
        throw new Error("checkout_adapters_unavailable");
      const quote = await this.validateQuote(id, actor);
      executionActor(quote, actor);
      const record = db
        .prepare(
          "SELECT * FROM checkout_executions WHERE operation_id = ? AND quote_id = ? AND customer_id = ?",
        )
        .get(quote.operationId, id, actor.customerId);
      if (!record) throw new Error("checkout_not_started");
      if (record.status === "completed")
        return { status: "completed", order: JSON.parse(record.order_data) };
      let order;
      try {
        order = await provider.reconcile({
          quote: structuredClone(quote),
          idempotencyKey: record.provider_key,
        });
      } catch {
        return { status: "processing" };
      }
      if (!order || !nonempty(order.id)) return { status: "processing" };
      const data = JSON.stringify({
        id: order.id,
        customerId: quote.customerId,
        operationId: quote.operationId,
        quoteId: quote.id,
        totalMinor: quote.totalMinor,
        currency: quote.currency,
      });
      db.prepare(
        "UPDATE checkout_executions SET status = 'completed', order_data = ? WHERE operation_id = ? AND status = 'processing'",
      ).run(data, quote.operationId);
      const saved = db
        .prepare(
          "SELECT order_data FROM checkout_executions WHERE operation_id = ?",
        )
        .get(quote.operationId);
      return { status: "completed", order: JSON.parse(saved.order_data) };
    },
    // Review proof is bound to an exact immutable quote revision.
    async recordHumanReview(id, actor) {
      validateActor(actor);
      if (actor.kind !== "human") fail();
      const verify = options.verifyHumanReview;
      if (typeof verify !== "function")
        throw new Error("human_review_unavailable");
      const quote = await this.validateQuote(id, actor);
      // The callback must independently verify a server-side, operation-bound proof.
      // No proof, assurance or human flag is accepted as an argument to this method.
      if (
        (await verify({
          actor: structuredClone(actor),
          quote: structuredClone(quote),
        })) !== true
      )
        throw new Error("human_review_unverified");
      // Re-read external address and current terms after the potentially slow verifier.
      await this.validateQuote(id, actor);
      return transaction(() => {
        const record = getQuoteRow.get(id);
        if (!record) fail();
        const row = get.get(record.cart_id);
        quoteActor(row, actor);
        const current = quoteView(record);
        const operation = db
          .prepare("SELECT * FROM checkout_operations WHERE cart_id = ?")
          .get(record.cart_id);
        if (
          !operation ||
          operation.operation_id !== quote.operationId ||
          operation.revision !== quote.revision ||
          current.id !== quote.id ||
          current.customerId !== actor.customerId ||
          row.version !== quote.cartVersion ||
          Date.now() >= Date.parse(quote.expiresAt) ||
          JSON.stringify(current) !== JSON.stringify(quote) ||
          JSON.stringify(pricedItems(row)) !== JSON.stringify(quote.items)
        )
          throw new Error("stale_quote");
        db.prepare(
          "INSERT OR IGNORE INTO quote_human_reviews VALUES (?, ?, ?, ?, ?)",
        ).run(
          quote.id,
          quote.operationId,
          quote.revision,
          quote.customerId,
          new Date().toISOString(),
        );
        return {
          status: "review_recorded",
          quoteId: quote.id,
          operationId: quote.operationId,
          revision: quote.revision,
        };
      });
    },
    getHumanReview(id, actor) {
      validateActor(actor);
      if (actor.kind !== "human") fail();
      const quote = getQuoteRow.get(id);
      if (!quote) fail();
      quoteActor(get.get(quote.cart_id), actor);
      const review = db
        .prepare("SELECT * FROM quote_human_reviews WHERE quote_id = ?")
        .get(id);
      return review
        ? {
            status: "review_recorded",
            quoteId: review.quote_id,
            operationId: review.operation_id,
            revision: review.revision,
          }
        : null;
    },
    close() {
      db.close();
    },
  };
}

/** Synthetic account data for local demonstrations only; never use as live identity or profile data. */
export function createFixtureCustomerAccountPort() {
  const addresses = [
    {
      id: "fixture-home",
      customerId: "fixture-customer",
      label: "Home (fixture)",
      version: "1",
      trustedForAgentCheckout: true,
      destination: { country: "US", postalCode: "10001" },
    },
    {
      id: "fixture-alternate",
      customerId: "fixture-customer",
      label: "Alternate (fixture)",
      version: "1",
      trustedForAgentCheckout: false,
      destination: { country: "US", postalCode: "94105" },
    },
  ];
  return {
    async listAddresses(customerId) {
      return structuredClone(
        addresses.filter((address) => address.customerId === customerId),
      );
    },
    async getAddress(customerId, addressId) {
      return structuredClone(
        addresses.find(
          (address) =>
            address.customerId === customerId && address.id === addressId,
        ) ?? null,
      );
    },
  };
}

/** Explicitly fixture-only policy and confirmation simulator, not identity proof. */
export function createFixtureAuthorization(mode) {
  if (mode !== "fixture") throw new Error("fixture_mode_required");
  const confirmations = new Set();
  const reviews = new Set();
  const key = (quote) =>
    `${quote.id}:${quote.operationId}:${quote.revision}:${quote.customerId}`;
  return {
    authorization: {
      async evaluate({ quote }) {
        return quote.requirement;
      },
    },
    async verifyAgentConfirmation({ quote }) {
      return confirmations.has(key(quote));
    },
    async verifyHumanReview({ quote }) {
      return reviews.has(key(quote));
    },
    confirmForTest(quote) {
      confirmations.add(key(quote));
    },
    reviewForTest(quote) {
      reviews.add(key(quote));
    },
  };
}

/** In-memory simulated order provider. It never charges and is not restart durable. */
export function createFixtureOrderProvider(mode) {
  if (mode !== "fixture") throw new Error("fixture_mode_required");
  const orders = new Map();
  return {
    async place({ idempotencyKey }) {
      if (!orders.has(idempotencyKey))
        orders.set(idempotencyKey, { id: randomUUID() });
      return structuredClone(orders.get(idempotencyKey));
    },
    async reconcile({ idempotencyKey }) {
      return structuredClone(orders.get(idempotencyKey) ?? null);
    },
  };
}
