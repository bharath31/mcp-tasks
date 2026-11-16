import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  createCartStore,
  createFixtureAuthorization,
  createFixtureCustomerAccountPort,
} from "../../../packages/commerce/src/index.js";

// This is a local simulation, never an authentication or payment implementation.
export function fixtureApi(databasePath, origin) {
  const accounts = createFixtureCustomerAccountPort();
  const authority = createFixtureAuthorization("fixture");
  const ledger = new DatabaseSync(databasePath);
  ledger.exec(
    `PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS fixture_provider_orders (provider_key TEXT PRIMARY KEY, id TEXT NOT NULL, quote TEXT NOT NULL)`,
  );
  const provider = {
    async place({ quote, idempotencyKey }) {
      ledger
        .prepare(
          "INSERT OR IGNORE INTO fixture_provider_orders VALUES (?, ?, ?)",
        )
        .run(idempotencyKey, randomUUID(), JSON.stringify(quote));
      return {
        id: ledger
          .prepare(
            "SELECT id FROM fixture_provider_orders WHERE provider_key = ?",
          )
          .get(idempotencyKey).id,
      };
    },
    async reconcile({ idempotencyKey }) {
      return (
        ledger
          .prepare(
            "SELECT id FROM fixture_provider_orders WHERE provider_key = ?",
          )
          .get(idempotencyKey) ?? null
      );
    },
  };
  const store = createCartStore(databasePath, {
    ...authority,
    customerAccount: accounts,
    orderProvider: provider,
  });
  const sessions = new Map();
  const scopes = [
    "cart:write",
    "checkout:write",
    "addresses:read",
    "orders:read",
  ];
  function actor(session) {
    if (session.kind === "human")
      return { kind: "human", customerId: "fixture-customer", scopes: [] };
    return {
      kind: "agent",
      agentId: "fixture-agent",
      pairwiseUserId: session.id,
      sessionId: session.id,
      ...(session.granted
        ? { customerId: "fixture-customer", scopes }
        : { scopes: [] }),
    };
  }
  function send(res, status, data) {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(data));
  }
  async function body(req) {
    if (
      !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")
    )
      throw Error("invalid_request");
    let chunks = "",
      size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) throw Error("invalid_request");
      chunks += chunk.toString();
    }
    try {
      return chunks ? JSON.parse(chunks) : {};
    } catch {
      throw Error("invalid_request");
    }
  }
  function publicQuote(quote) {
    const { destination, ...view } = quote;
    return {
      ...view,
      destinationLabel: destination.label,
      shippingAddressId: destination.id,
    };
  }
  async function handle(req, res) {
    try {
      const url = new URL(req.url, origin);
      if (url.origin !== origin || !url.pathname.startsWith("/api/"))
        return send(res, 400, {
          code: "invalid_request",
          message: "Invalid request.",
        });
      const mutation = !["GET", "HEAD"].includes(req.method);
      if (mutation && req.headers.origin !== origin)
        return send(res, 403, {
          code: "origin_denied",
          message: "Origin denied.",
        });
      const match = /(?:^|;\s*)fixture_session=([a-f0-9]{64})(?:;|$)/.exec(
        req.headers.cookie ?? "",
      );
      let session = match && sessions.get(match[1]);
      if (!session && req.method === "GET" && url.pathname === "/api/session") {
        const token = randomBytes(32).toString("hex");
        session = { id: randomUUID(), kind: "agent", granted: false };
        sessions.set(token, session);
        res.setHeader(
          "Set-Cookie",
          `fixture_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
        );
      }
      if (!session && url.pathname !== "/api/catalog")
        return send(res, 401, {
          code: "session_required",
          message: "Start a fixture session first.",
        });
      const p = url.pathname.split("/").slice(2);
      const a = session && actor(session);
      const publicActor = (value) => ({
        kind: value.kind,
        ...(value.customerId ? { customerId: value.customerId } : {}),
        ...(value.agentId ? { agentId: value.agentId } : {}),
        scopes: value.scopes,
      });
      if (req.method === "GET" && p[0] === "catalog" && p.length === 1)
        return send(res, 200, { products: store.catalog() });
      if (req.method === "GET" && p[0] === "session" && p.length === 1)
        return send(res, 200, {
          mode: "fixture",
          actor: publicActor(a),
          capabilities: { directCustomerVerification: true, poppy: false },
        });
      if (req.method === "POST" && p[0] === "fixture" && p.length === 2) {
        await body(req);
        if (p[1] === "grant" && session.kind === "agent")
          session.granted = true;
        else if (p[1] === "human" && session.granted) session.kind = "human";
        else if (p[1] === "agent" && session.granted) session.kind = "agent";
        else
          return send(res, 403, {
            code: "transition_denied",
            message: "Fixture transition not allowed.",
          });
        return send(res, 200, { actor: publicActor(actor(session)) });
      }
      if (req.method === "GET" && p[0] === "addresses" && p.length === 1) {
        if (
          !a.customerId ||
          (a.kind === "agent" && !a.scopes.includes("addresses:read"))
        )
          throw Error("not_found_or_forbidden");
        const addresses = await accounts.listAddresses(a.customerId);
        return send(res, 200, {
          addresses: addresses.map(
            ({ id, label, trustedForAgentCheckout }) => ({
              id,
              label,
              trustedForAgentCheckout,
            }),
          ),
        });
      }
      if (p[0] === "carts") {
        if (req.method === "POST" && p.length === 1) {
          await body(req);
          return send(res, 200, { cart: store.create(a) });
        }
        if (req.method === "GET" && p.length === 2)
          return send(res, 200, { cart: store.read(p[1], a) });
        if (req.method === "POST" && p.length === 3 && p[2] === "link") {
          await body(req);
          return send(res, 200, { cart: store.link(p[1], a) });
        }
        if (req.method === "PUT" && p.length === 3 && p[2] === "items") {
          const b = await body(req);
          return send(res, 200, { cart: store.update(p[1], a, b.items) });
        }
        if (req.method === "POST" && p.length === 3 && p[2] === "quote") {
          const b = await body(req);
          return send(res, 200, {
            quote: publicQuote(
              await store.createQuote(p[1], a, b.shippingAddressId),
            ),
          });
        }
      }
      if (p[0] === "checkouts" && p.length >= 2) {
        if (req.method === "GET" && p.length === 2)
          return send(res, 200, {
            quote: publicQuote(store.getQuote(p[1], a)),
          });
        if (req.method === "POST" && p.length === 3) {
          await body(req);
          if (p[2] === "confirm") {
            if (a.kind !== "agent" || !a.customerId)
              throw Error("not_found_or_forbidden");
            const quote = await store.validateQuote(p[1], a);
            authority.confirmForTest(quote);
            return send(res, 200, {
              status: "fixture_confirmation_recorded",
              operationId: quote.operationId,
              revision: quote.revision,
            });
          }
          if (p[2] === "approve") {
            if (a.kind !== "human") throw Error("not_found_or_forbidden");
            const quote = await store.validateQuote(p[1], a);
            authority.reviewForTest(quote);
            return send(res, 200, await store.recordHumanReview(p[1], a));
          }
          if (p[2] === "complete") {
            if (
              typeof req.headers["idempotency-key"] !== "string" ||
              !req.headers["idempotency-key"] ||
              req.headers["idempotency-key"].length > 128
            )
              throw Error("invalid_request");
            const result = await store.completeQuote(p[1], a);
            if (result.status === "customer_verification_required")
              result.reviewUrl = `/review/${encodeURIComponent(p[1])}`;
            return send(res, 200, result);
          }
          if (p[2] === "reconcile")
            return send(res, 200, await store.reconcileQuote(p[1], a));
        }
      }
      if (req.method === "GET" && p[0] === "orders" && p.length === 1) {
        if (
          !a.customerId ||
          (a.kind === "agent" && !a.scopes.includes("orders:read"))
        )
          throw Error("not_found_or_forbidden");
        const rows = ledger
          .prepare(
            "SELECT order_data FROM checkout_executions WHERE customer_id = ? AND status = 'completed'",
          )
          .all(a.customerId);
        return send(res, 200, {
          orders: rows.map((r) => JSON.parse(r.order_data)),
        });
      }
      return send(res, 404, { code: "not_found", message: "Not found." });
    } catch (e) {
      const code = [
        "not_found_or_forbidden",
        "stale_quote",
        "invalid_items",
        "empty_cart",
        "checkout_processing",
        "invalid_request",
      ].includes(e?.message)
        ? e.message
        : "request_failed";
      return send(res, code === "not_found_or_forbidden" ? 403 : 400, {
        code,
        message:
          code === "stale_quote"
            ? "Quote is stale; request a new quote."
            : "The fixture request could not be completed.",
      });
    }
  }
  return {
    handle,
    close() {
      store.close();
      ledger.close();
    },
  };
}
