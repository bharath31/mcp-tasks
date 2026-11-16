import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// This is a partial milestone. In particular, there is no checkout or payment API.
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
        if (!op) {
          db.prepare("INSERT INTO checkout_operations VALUES (?, ?, 0)").run(
            cartId,
            randomUUID(),
          );
          op = db
            .prepare("SELECT * FROM checkout_operations WHERE cart_id = ?")
            .get(cartId);
        }
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
          requirement: "denied",
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
