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
export function createCartStore(path) {
  if (!nonempty(path)) throw new Error("database_path_required");
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS carts (
      id TEXT PRIMARY KEY, customer_id TEXT, agent_id TEXT, pairwise_user_id TEXT,
      session_id TEXT, version INTEGER NOT NULL, items TEXT NOT NULL
    );`);
  const get = db.prepare("SELECT * FROM carts WHERE id = ?");
  function authorize(row, actor) {
    validateActor(actor);
    if (!row) fail();
    if (row.customer_id) {
      if (actor.customerId !== row.customer_id) fail();
      if (
        actor.kind === "agent" &&
        (!actor.scopes.includes("cart:write") ||
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
    close() {
      db.close();
    },
  };
}
