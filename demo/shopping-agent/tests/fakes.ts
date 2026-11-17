import type { HostAction } from "../src/actions.js";
import type {
  BrowserLauncher,
  BrowserSessionPort,
  HostActionResult,
  ModelPort,
  ModelRunInput,
  ParsedModelOutput,
} from "../src/ports.js";

export class FakeBrowserSession implements BrowserSessionPort {
  readonly sessionId: string;
  closed = false;
  navigations: string[] = [];
  clicks: string[] = [];
  cartItems: { productId: string; quantity: number }[] = [];
  rejectNextAdd = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async gotoTrusted(url: string): Promise<void> {
    this.navigations.push(url);
  }

  async runHostAction(action: HostAction): Promise<HostActionResult> {
    if (this.closed) return { ok: false, error: "session closed" };
    switch (action.kind) {
      case "view_catalog":
        return {
          ok: true,
          kind: "view_catalog",
          catalog: {
            products: [
              { id: "tray", name: "Catchall tray", priceMinor: 2400, currency: "USD" },
            ],
          },
        };
      case "add_to_cart": {
        if (this.rejectNextAdd) {
          return { ok: false, error: "checkout", code: "checkout_boundary" };
        }
        this.clicks.push(action.productId);
        const existing = this.cartItems.find((i) => i.productId === action.productId);
        if (existing) existing.quantity += 1;
        else this.cartItems.push({ productId: action.productId, quantity: 1 });
        return { ok: true, kind: "add_to_cart", productId: action.productId };
      }
      case "view_cart":
        return {
          ok: true,
          kind: "view_cart",
          cart: { items: [...this.cartItems], checkoutAllowed: false },
        };
      default:
        return { ok: false, error: `unsupported in fake: ${action.kind}` };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export function fakeBrowserLauncher(
  factory?: (id: string) => FakeBrowserSession,
): BrowserLauncher {
  return async ({ sessionId }) => factory?.(sessionId) ?? new FakeBrowserSession(sessionId);
}

export function scriptedModel(
  script: ParsedModelOutput[],
  parse: (raw: unknown) => ParsedModelOutput = (raw) => raw as ParsedModelOutput,
): ModelPort {
  let i = 0;
  return {
    async run(_model: string, _input: ModelRunInput) {
      const step = script[i++] ?? { content: "done", toolCalls: [] };
      return step;
    },
    parseOutput: parse,
  };
}