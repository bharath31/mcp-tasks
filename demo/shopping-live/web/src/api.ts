import type {
  AgentRun,
  ApprovalRecord,
  Cart,
  OrderResult,
  Quote,
  SessionResponse,
} from "./types.js";

export class ShoppingApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ShoppingApiError";
    this.code = code;
    this.status = status;
  }
}

let sessionCsrf: string | null = null;
let agentBrowserCsrf: string | null = null;

export function setSessionCsrfToken(token: string | null | undefined): void {
  sessionCsrf = typeof token === "string" && token.length > 0 ? token : null;
}

export function setAgentBrowserCsrfToken(
  token: string | null | undefined,
): void {
  agentBrowserCsrf =
    typeof token === "string" && token.length > 0 ? token : null;
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: ShoppingApiError }> {
  let response: Response;
  try {
    const method = init?.method?.toUpperCase() ?? "GET";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (sessionCsrf && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers["x-nominee-csrf"] = sessionCsrf;
    }
    if (
      agentBrowserCsrf &&
      path.startsWith("/agent-browser/") &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(method)
    ) {
      headers["x-nominee-agent-browser-csrf"] = agentBrowserCsrf;
    }
    response = await fetch(`/api${path}`, {
      ...init,
      cache: "no-store",
      headers,
    });
  } catch {
    return {
      ok: false,
      error: new ShoppingApiError(
        "The Nominee shopping API is not reachable from this browser.",
        "network_error",
        0,
      ),
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      error: new ShoppingApiError(
        response.ok
          ? "The shopping API returned an invalid response."
          : "The shopping API is unavailable.",
        "invalid_response",
        response.status,
      ),
    };
  }

  if (!response.ok) {
    const record = body as { code?: string; message?: string; error?: string };
    return {
      ok: false,
      error: new ShoppingApiError(
        record.message ??
          record.error ??
          "The shopping API could not complete this request.",
        record.code ?? "request_failed",
        response.status,
      ),
    };
  }

  return { ok: true, data: body as T };
}

/** Typed client for the live shopping worker — session cookies only. */
async function signOutRequest(): Promise<
  | { ok: true; data: Record<string, never> }
  | { ok: false; error: ShoppingApiError }
> {
  let response: Response;
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (sessionCsrf) {
      headers["x-nominee-csrf"] = sessionCsrf;
    }
    response = await fetch("/auth/logout", {
      method: "POST",
      cache: "no-store",
      headers,
    });
  } catch {
    return {
      ok: false,
      error: new ShoppingApiError(
        "The Nominee shopping API is not reachable from this browser.",
        "network_error",
        0,
      ),
    };
  }
  if (response.status === 303 || response.ok) {
    return { ok: true, data: {} };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      error: new ShoppingApiError(
        "Sign out could not be completed.",
        "sign_out_failed",
        response.status,
      ),
    };
  }
  const record = body as { code?: string; message?: string; error?: string };
  return {
    ok: false,
    error: new ShoppingApiError(
      record.message ?? record.error ?? "Sign out could not be completed.",
      record.code ?? "sign_out_failed",
      response.status,
    ),
  };
}

export const shoppingApi = {
  session: () => request<SessionResponse>("/session"),

  signOut: () => signOutRequest(),

  startAgent: (goal: string) =>
    request<AgentRun>("/agent/start", {
      method: "POST",
      body: JSON.stringify({ goal }),
    }),

  agent: (id: string) => request<AgentRun>(`/agent/${encodeURIComponent(id)}`),

  agentBrowserSession: () =>
    request<{ agentBrowser: boolean; csrfToken: string }>(
      "/agent-browser/session",
    ),

  agentBrowserCart: () => request<{ cart: Cart | null }>("/agent-browser/cart"),

  agentBrowserAddCartItem: (productId: string, quantity = 1) =>
    request<{ cart: Cart | null }>("/agent-browser/cart/items", {
      method: "POST",
      body: JSON.stringify({ productId, quantity }),
    }),

  cart: () => request<{ cart: Cart | null }>("/cart"),

  addCartItem: (productId: string, quantity = 1) =>
    request<{ cart: Cart | null }>("/cart/items", {
      method: "POST",
      body: JSON.stringify({ productId, quantity }),
    }),

  quote: () =>
    request<{ quote: Quote }>("/quote", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  startApproval: (quoteId: string) =>
    request<ApprovalRecord>("/approval/start", {
      method: "POST",
      body: JSON.stringify({ quoteId }),
    }),

  approval: (id: string) =>
    request<ApprovalRecord>(`/approval/${encodeURIComponent(id)}`),

  executeOrder: (quoteId: string) =>
    request<OrderResult>("/order/execute", {
      method: "POST",
      body: JSON.stringify({ quoteId }),
    }),

  checkoutResume: () =>
    request<{
      quote: Quote | null;
      approval: ApprovalRecord | null;
      agent: AgentRun | null;
    }>("/checkout/resume"),
};

export type ShoppingApi = typeof shoppingApi;
