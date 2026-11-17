import type { HostAction } from "../../../../shopping-agent/src/actions.js";
import type {
  BrowserLauncher,
  BrowserSessionPort,
  HostActionResult,
} from "../../../../shopping-agent/src/ports.js";
import { scriptedModel } from "../../../../shopping-agent/tests/fakes.js";
import type { RunPortsFactory } from "../../../../shopping-agent-orchestration/src/types.js";
import type { ShoppingAgentOrchestrationEnv } from "../../../../shopping-agent-orchestration/src/types.js";

const TRAY_SCRIPT = [
  {
    content: null,
    toolCalls: [
      { id: "1", name: "view_catalog", arguments: "{}" },
      { id: "2", name: "add_to_cart", arguments: JSON.stringify({ productId: "tray" }) },
      {
        id: "3",
        name: "finish_session",
        arguments: JSON.stringify({ summary: "Added tray via agent-browser HTTP." }),
      },
    ],
  },
];

function cookieHeaderFromInit(
  initCookies: { name: string; value: string }[],
): string {
  return initCookies
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join("; ");
}

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

class HttpCapabilityBrowserSession implements BrowserSessionPort {
  readonly sessionId: string;
  private readonly cookie: string;
  private readonly apiOrigin: string;
  private readonly fetchImpl: FetchLike;
  private csrf: string | null = null;

  constructor(
    sessionId: string,
    cookie: string,
    apiOrigin: string,
    fetchImpl: FetchLike,
  ) {
    this.sessionId = sessionId;
    this.cookie = cookie;
    this.apiOrigin = apiOrigin;
    this.fetchImpl = fetchImpl;
  }

  async gotoTrusted(url: string): Promise<void> {
    void url;
  }

  private async loadCsrf(): Promise<string> {
    if (this.csrf) return this.csrf;
    const res = await this.fetchImpl(`${this.apiOrigin}/api/agent-browser/session`, {
      headers: { cookie: this.cookie, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`agent_browser_session:${res.status}`);
    const body = (await res.json()) as { csrfToken?: string };
    if (!body.csrfToken) throw new Error("agent_browser_csrf_missing");
    this.csrf = body.csrfToken;
    return this.csrf;
  }

  async runHostAction(action: HostAction): Promise<HostActionResult> {
    switch (action.kind) {
      case "view_catalog":
        return {
          ok: true,
          kind: "view_catalog",
          catalog: {
            products: [
              {
                id: "tray",
                name: "Catchall tray",
                priceMinor: 2400,
                currency: "USD",
              },
            ],
          },
        };
      case "add_to_cart": {
        const csrf = await this.loadCsrf();
        const res = await this.fetchImpl(`${this.apiOrigin}/api/agent-browser/cart/items`, {
          method: "POST",
          headers: {
            cookie: this.cookie,
            accept: "application/json",
            "content-type": "application/json",
            origin: this.apiOrigin,
            "x-nominee-agent-browser-csrf": csrf,
          },
          body: JSON.stringify({ productId: action.productId, quantity: 1 }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { message?: string };
          return {
            ok: false,
            error: err.message ?? `agent_browser_add:${res.status}`,
          };
        }
        return { ok: true, kind: "add_to_cart", productId: action.productId };
      }
      case "view_cart": {
        const res = await this.fetchImpl(`${this.apiOrigin}/api/agent-browser/cart`, {
          headers: { cookie: this.cookie, accept: "application/json" },
        });
        if (!res.ok) {
          return { ok: false, error: `agent_browser_cart:${res.status}` };
        }
        const body = (await res.json()) as {
          cart?: { items?: { productId: string; quantity: number }[] };
        };
        return {
          ok: true,
          kind: "view_cart",
          cart: {
            items: body.cart?.items ?? [],
            checkoutAllowed: false,
          },
        };
      }
      default:
        return { ok: false, error: `unsupported:${action.kind}` };
    }
  }

  async close(): Promise<void> {}
}

function httpCapabilityBrowserLauncher(
  apiOrigin: string,
  fetchImpl: FetchLike,
): BrowserLauncher {
  return async ({ sessionId, initCookies }) => {
    const cookies = initCookies ?? [];
    return new HttpCapabilityBrowserSession(
      sessionId,
      cookieHeaderFromInit(cookies),
      apiOrigin,
      fetchImpl,
    );
  };
}

/** Injectable ports: real HTTP to /api/agent-browser/* (not Puppeteer; UI path unproven). */
export function httpAgentCapabilityPortsFactory(
  apiOrigin: string,
): RunPortsFactory {
  return ({ env }) => {
    const subfetch = (env as ShoppingAgentOrchestrationEnv).SELF_SUBFETCH;
    const fetchImpl: FetchLike = subfetch
      ? (input, init) => subfetch.fetch(input, init)
      : (input, init) => fetch(input, init);
    return {
      model: scriptedModel(TRAY_SCRIPT),
      launchBrowser: httpCapabilityBrowserLauncher(apiOrigin, fetchImpl),
    };
  };
}