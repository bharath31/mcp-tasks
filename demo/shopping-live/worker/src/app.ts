import type { CustomerAccessTokenDeps } from "../../../shopping-merchant/src/identity/customer-access-token.js";
import type { ShoppingLiveEnv } from "./env.js";
import { json, problem, publicOrigin, serviceUnavailable } from "./http.js";
import {
  handleAuthCallback,
  handleAuthLogin,
  handleAuthLogout,
  sessionPayload,
} from "./auth.js";
import { assertSameOrigin, sessionCsrfToken } from "./csrf.js";
import { resolveCustomerSession } from "./session.js";
import {
  addCartItem,
  createCustomerQuote,
  readCustomerCart,
} from "./cart.js";

const DEFERRED_PREFIXES = [
  "/api/agent",
  "/api/approval",
  "/api/order",
] as const;

function isDeferredApi(path: string): boolean {
  return DEFERRED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function deferredResponse(path: string): Response {
  const feature =
    path.startsWith("/api/agent") ? "agent" :
    path.startsWith("/api/approval") ? "approval" : "order";
  return serviceUnavailable(
    `${feature}_unavailable`,
    `${feature === "agent" ? "Agent runs" : feature === "approval" ? "Guardian approval" : "Order execution"} are not connected until CIBA and live approval are integrated.`,
  );
}

export function createShoppingApp(deps: CustomerAccessTokenDeps = {}) {
  return {
    async fetch(req: Request, env: ShoppingLiveEnv): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (
        env.SHOPPING_TEST_HOOKS === "1" &&
        path === "/test/seed-session" &&
        req.method === "POST"
      ) {
        const body = (await req.json().catch(() => null)) as {
          customerId?: string;
          innerSid?: string;
          accessToken?: string;
        } | null;
        if (!body?.customerId) {
          return problem(400, "invalid_body", "customerId is required.");
        }
        const innerSid = body.innerSid ?? crypto.randomUUID().replace(/-/g, "");
        let accessToken = body.accessToken;
        if (!accessToken) {
          const { mintCustomerAccessToken } = await import(
            "../../../shopping-merchant/tests/support/identity-jwt.js"
          );
          accessToken = await mintCustomerAccessToken({ sub: body.customerId });
        }
        const verified = await (
          await import("../../../shopping-merchant/src/identity/index.js")
        ).verifyCustomerAccessToken(env, accessToken, deps);
        if (!verified || verified.customerId !== body.customerId) {
          return problem(403, "token_rejected", "Access token failed verification.");
        }
        const stub = (await import("./customer-state-do.js")).customerStateStub(
          env,
          body.customerId,
        );
        await (await import("./customer-state-do.js")).customerStateRpc(
          stub,
          body.customerId,
          { op: "bindCustomer", customerId: body.customerId },
        );
        await (await import("./customer-state-do.js")).customerStateRpc(
          stub,
          body.customerId,
          {
            op: "createSession",
            sid: innerSid,
            accessToken,
            expiresAtMs: Date.now() + 3600_000,
          },
        );
        const signed = await (
          await import("./crypto-util.js")
        ).signValue(
          env.SHOPPING_SESSION_SECRET!,
          JSON.stringify({ customerId: body.customerId, sid: innerSid }),
        );
        return json({
          cookie: `nsh_sid=${encodeURIComponent(signed)}`,
          csrfToken: innerSid,
        });
      }

      if (path.startsWith("/auth/")) {
        if (path === "/auth/login" && req.method === "GET") {
          return handleAuthLogin(req, env);
        }
        if (path === "/auth/callback" && req.method === "GET") {
          return handleAuthCallback(req, env, deps);
        }
        if (path === "/auth/logout" && req.method === "GET") {
          return handleAuthLogout(req, env);
        }
        return problem(404, "not_found", "Not found.");
      }

      if (path.startsWith("/api/")) {
        if (isDeferredApi(path) && req.method !== "OPTIONS") {
          return deferredResponse(path);
        }

        if (path === "/api/session" && req.method === "GET") {
          const customer = await resolveCustomerSession(req, env, deps);
          const body = sessionPayload(req, env, customer);
          if (customer) {
            return json({ ...body, csrfToken: sessionCsrfToken(customer.innerSid) });
          }
          return json(body);
        }

        const customer = await resolveCustomerSession(req, env, deps);
        if (!customer) {
          return problem(401, "unauthorized", "Sign in required.");
        }

        if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
          const blocked = assertSameOrigin(req, env);
          if (blocked) return blocked;
          const csrf =
            req.headers.get("x-nominee-csrf") ??
            req.headers.get("X-Nominee-Csrf");
          if (csrf !== sessionCsrfToken(customer.innerSid)) {
            return problem(403, "csrf_required", "CSRF token mismatch.");
          }
        }

        try {
          if (path === "/api/cart" && req.method === "GET") {
            const cart = await readCustomerCart(env, customer);
            return json({ cart });
          }

          if (path === "/api/cart/items" && req.method === "POST") {
            const body = (await req.json().catch(() => null)) as {
              productId?: unknown;
              quantity?: unknown;
            } | null;
            const productId =
              typeof body?.productId === "string" ? body.productId.trim() : "";
            const quantity =
              typeof body?.quantity === "number" ? body.quantity : 1;
            if (!productId) {
              return problem(400, "invalid_item", "productId is required.");
            }
            const cart = await addCartItem(env, customer, productId, quantity);
            return json({ cart });
          }

          if (path === "/api/quote" && req.method === "POST") {
            const quote = await createCustomerQuote(env, customer);
            return json({ quote });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "error";
          if (message === "merchant_unavailable" || message.includes("merchant")) {
            return serviceUnavailable("merchant_unavailable", "Merchant ledger is unavailable.");
          }
          if (message === "invalid_item" || message === "cart_update_failed") {
            return problem(422, message, "Cart update rejected.");
          }
          if (message === "shipping_unconfigured") {
            return serviceUnavailable("shipping_unconfigured", "Merchant shipping destination is not configured.");
          }
          return problem(409, message, "Request could not be completed.");
        }

        return problem(404, "not_found", "Not found.");
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(req);
      }
      return problem(404, "not_found", "Not found.");
    },
  };
}