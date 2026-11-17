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
import { addCartItem, createCustomerQuote, readCustomerCart } from "./cart.js";
import { pollCustomerApproval, startCustomerApproval } from "./approval.js";
import {
  executeCustomerOrder,
  guardianOrderExecutionEnabled,
} from "./order.js";

const DEFERRED_AGENT_PREFIX = "/api/agent";

function isDeferredAgent(path: string): boolean {
  return (
    path === DEFERRED_AGENT_PREFIX ||
    path.startsWith(`${DEFERRED_AGENT_PREFIX}/`)
  );
}

export function createShoppingApp(deps: CustomerAccessTokenDeps = {}) {
  return {
    async fetch(req: Request, env: ShoppingLiveEnv): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path.startsWith("/auth/")) {
        if (path === "/auth/login" && req.method === "GET") {
          return handleAuthLogin(req, env);
        }
        if (path === "/auth/callback" && req.method === "GET") {
          return handleAuthCallback(req, env, deps);
        }
        if (path === "/auth/logout") {
          if (req.method === "GET") {
            return problem(
              405,
              "method_not_allowed",
              "Sign out requires POST with a CSRF token.",
            );
          }
          if (req.method === "POST") {
            const customer = await resolveCustomerSession(req, env, deps);
            if (!customer) {
              return problem(401, "unauthorized", "Sign in required.");
            }
            const blocked = assertSameOrigin(req, env);
            if (blocked) return blocked;
            const csrf =
              req.headers.get("x-nominee-csrf") ??
              req.headers.get("X-Nominee-Csrf");
            if (csrf !== sessionCsrfToken(customer.innerSid)) {
              return problem(403, "csrf_required", "CSRF token mismatch.");
            }
            return handleAuthLogout(req, env, deps);
          }
        }
        return problem(404, "not_found", "Not found.");
      }

      if (path.startsWith("/api/")) {
        if (isDeferredAgent(path) && req.method !== "OPTIONS") {
          return serviceUnavailable(
            "agent_unavailable",
            "Agent runs are not connected in this slice.",
          );
        }

        if (path === "/api/session" && req.method === "GET") {
          const customer = await resolveCustomerSession(req, env, deps);
          const body = sessionPayload(req, env, customer);
          if (customer) {
            return json({
              ...body,
              csrfToken: sessionCsrfToken(customer.innerSid),
            });
          }
          return json(body);
        }

        const customer = await resolveCustomerSession(req, env, deps);
        if (!customer) {
          return problem(401, "unauthorized", "Sign in required.");
        }

        if (
          req.method === "POST" ||
          req.method === "PUT" ||
          req.method === "PATCH"
        ) {
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

          if (path === "/api/approval/start" && req.method === "POST") {
            const body = (await req.json().catch(() => null)) as {
              quoteId?: unknown;
            } | null;
            const quoteId =
              typeof body?.quoteId === "string" ? body.quoteId.trim() : "";
            if (!quoteId) {
              return problem(400, "invalid_quote", "quoteId is required.");
            }
            const approval = await startCustomerApproval(
              env,
              customer,
              quoteId,
            );
            return json(approval);
          }

          const approvalPoll = path.match(/^\/api\/approval\/([^/]+)$/);
          if (approvalPoll && req.method === "GET") {
            const challengeId = decodeURIComponent(approvalPoll[1]!);
            const approval = await pollCustomerApproval(
              env,
              customer,
              challengeId,
            );
            return json(approval);
          }

          if (path === "/api/order/execute" && req.method === "POST") {
            if (!guardianOrderExecutionEnabled(env)) {
              return serviceUnavailable(
                "order_execute_unavailable",
                "Order execution stays disabled until Guardian live rendering is operator-confirmed.",
              );
            }
            const body = (await req.json().catch(() => null)) as {
              quoteId?: unknown;
            } | null;
            const quoteId =
              typeof body?.quoteId === "string" ? body.quoteId.trim() : "";
            if (!quoteId) {
              return problem(400, "invalid_quote", "quoteId is required.");
            }
            const order = await executeCustomerOrder(env, customer, quoteId);
            return json(order);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "error";
          if (
            message === "merchant_unavailable" ||
            message.includes("merchant")
          ) {
            return serviceUnavailable(
              "merchant_unavailable",
              "Merchant ledger is unavailable.",
            );
          }
          if (message === "invalid_item" || message === "cart_update_failed") {
            return problem(422, message, "Cart update rejected.");
          }
          if (message === "shipping_unconfigured") {
            return serviceUnavailable(
              "shipping_unconfigured",
              "Merchant shipping destination is not configured.",
            );
          }
          if (
            message === "ciba_unconfigured" ||
            message === "approval_start_failed"
          ) {
            return serviceUnavailable(
              "approval_unavailable",
              "Guardian approval is not configured for this deployment.",
            );
          }
          if (message === "order_execute_unavailable") {
            return serviceUnavailable(
              "order_execute_unavailable",
              "Order execution stays disabled until Guardian live rendering is operator-confirmed.",
            );
          }
          if (message === "order_approval_required") {
            return problem(
              409,
              "order_approval_required",
              "Guardian approval must be recorded on the merchant ledger before checkout.",
            );
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
