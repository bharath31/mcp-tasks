import type { CustomerAccessTokenDeps } from "../../../shopping-merchant/src/identity/customer-access-token.js";
import type { ShoppingLiveEnv } from "./env.js";
import { json, problem, serviceUnavailable } from "./http.js";
import {
  agentBrowserAsCustomer,
  agentBrowserPostCsrfOk,
  resolveAgentBrowserContext,
} from "./agent-browser-auth.js";
import {
  agentIntegrationConfigured,
  handleAgentPoll,
  handleAgentStart,
  type AgentHostDeps,
} from "./agent-host.js";
import {
  handleAuthCallback,
  handleAuthLogin,
  handleAuthLogout,
  sessionPayload,
} from "./auth.js";
import { assertSameOrigin, sessionCsrfToken } from "./csrf.js";
import { resolveCustomerSession } from "./session.js";
import { resumeCustomerCheckout } from "./checkout-resume.js";
import {
  addAgentBrowserCartItem,
  addCartItem,
  createCustomerQuote,
  readAgentBrowserCart,
  readCustomerCart,
  readCustomerQuote,
} from "./cart.js";
import { pollCustomerApproval, startCustomerApproval } from "./approval.js";
import {
  executeCustomerOrder,
  guardianOrderExecutionEnabled,
} from "./order.js";

const AGENT_PREFIX = "/api/agent";
const AGENT_BROWSER_PREFIX = "/api/agent-browser";

export function createShoppingApp(deps: AgentHostDeps = {}) {
  return {
    async fetch(
      req: Request,
      env: ShoppingLiveEnv,
      ctx?: ExecutionContext,
    ): Promise<Response> {
      const executionCtx =
        ctx ??
        ({
          waitUntil(promise: Promise<unknown>) {
            void promise;
          },
          passThroughOnException() {},
        } as ExecutionContext);
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
        if (path.startsWith(AGENT_BROWSER_PREFIX) && req.method !== "OPTIONS") {
          const agentBrowser = await resolveAgentBrowserContext(req, env);
          if (!agentBrowser) {
            return problem(
              403,
              "agent_browser_denied",
              "Agent browser access denied.",
            );
          }
          const customer = await agentBrowserAsCustomer(
            env,
            agentBrowser,
            deps,
          );
          if (!customer) {
            return problem(
              401,
              "parent_session_revoked",
              "Parent session is no longer active.",
            );
          }
          if (path === "/api/agent-browser/session" && req.method === "GET") {
            return json({
              agentBrowser: true,
              csrfToken: agentBrowser.csrfToken,
            });
          }
          if (path === "/api/agent-browser/cart" && req.method === "GET") {
            const cart = await readAgentBrowserCart(env, customer);
            return json({ cart });
          }
          if (
            path === "/api/agent-browser/cart/items" &&
            req.method === "POST"
          ) {
            if (!(await agentBrowserPostCsrfOk(env, agentBrowser, req))) {
              return problem(
                403,
                "csrf_required",
                "Agent browser CSRF token mismatch.",
              );
            }
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
            const cart = await addAgentBrowserCartItem(
              env,
              customer,
              productId,
              quantity,
            );
            return json({ cart });
          }
          return problem(404, "not_found", "Not found.");
        }

        if (path === "/api/agent/start" && req.method === "POST") {
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
          return handleAgentStart(req, env, customer, executionCtx, deps);
        }

        const agentPoll = path.match(/^\/api\/agent\/([^/]+)$/);
        if (agentPoll && req.method === "GET") {
          const customer = await resolveCustomerSession(req, env, deps);
          if (!customer) {
            return problem(401, "unauthorized", "Sign in required.");
          }
          const runId = decodeURIComponent(agentPoll[1]!);
          return handleAgentPoll(env, customer, runId);
        }

        if (
          (path === AGENT_PREFIX || path.startsWith(`${AGENT_PREFIX}/`)) &&
          !agentIntegrationConfigured(env) &&
          req.method !== "OPTIONS"
        ) {
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
          if (path === "/api/checkout/resume" && req.method === "GET") {
            const resumed = await resumeCustomerCheckout(env, customer);
            return json(resumed);
          }

          const quoteRead = path.match(/^\/api\/quote\/([^/]+)$/);
          if (quoteRead && req.method === "GET") {
            const quote = await readCustomerQuote(
              env,
              customer,
              decodeURIComponent(quoteRead[1]!),
            );
            if (!quote) {
              return problem(
                404,
                "quote_not_found",
                "Quote is missing or expired.",
              );
            }
            return json({ quote });
          }

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
