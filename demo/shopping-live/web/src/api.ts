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

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: ShoppingApiError }> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...init?.headers,
      },
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
export const shoppingApi = {
  session: () => request<SessionResponse>("/session"),

  startAgent: (goal: string) =>
    request<AgentRun>("/agent/start", {
      method: "POST",
      body: JSON.stringify({ goal }),
    }),

  agent: (id: string) =>
    request<AgentRun>(`/agent/${encodeURIComponent(id)}`),

  cart: () => request<{ cart: Cart | null }>("/cart"),

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
};

export type ShoppingApi = typeof shoppingApi;