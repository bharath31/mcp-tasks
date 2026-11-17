import type { HostAction } from "./actions.js";

export type CatalogSnapshot = {
  products: { id: string; name: string; priceMinor: number; currency: string }[];
};

export type CartSnapshot = {
  items: { productId: string; quantity: number }[];
  checkoutAllowed: false;
};

export type HostActionResult =
  | { ok: true; kind: "navigate"; url: string }
  | {
      ok: true;
      kind: "view_catalog";
      catalog: CatalogSnapshot;
      disclaimer?: string;
    }
  | { ok: true; kind: "add_to_cart"; productId: string }
  | { ok: true; kind: "view_cart"; cart: CartSnapshot }
  | { ok: true; kind: "stop"; summary: string }
  | { ok: false; error: string; code?: string };

/** Injectable browser port; production uses Cloudflare Browser Run via Puppeteer. */
export interface BrowserSessionPort {
  readonly sessionId: string;
  gotoTrusted(url: string): Promise<void>;
  runHostAction(action: HostAction): Promise<HostActionResult>;
  close(): Promise<void>;
}

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type ModelRunInput = {
  messages: ModelMessage[];
  tools: unknown[];
  temperature: number;
  max_completion_tokens: number;
};

export type ParsedModelOutput = {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
};

/** Injectable Workers AI port. */
export interface ModelPort {
  run(model: string, input: ModelRunInput): Promise<unknown>;
  parseOutput(raw: unknown): ParsedModelOutput;
}

export type BrowserLauncher = (opts: {
  sessionId: string;
  merchantHostname: string;
  allowedDomains: string[];
  /** Wall-clock millis after which host waits must fail closed. */
  sessionDeadlineMs: number;
}) => Promise<BrowserSessionPort>;