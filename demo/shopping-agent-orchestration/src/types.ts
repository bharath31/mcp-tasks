import type { ShoppingAgentConfig } from "../../shopping-agent/src/config.js";
import type { WorkersAiBinding } from "../../shopping-agent/src/model/workers-ai-adapter.js";

/** Wrangler-style bindings the shopping-live host must wire (not edited in this slice). */
export type ShoppingAgentOrchestrationBindings = {
  /** Workers AI (`"ai": { "binding": "AI" }`). */
  AI: WorkersAiBinding;
  /** Browser Run (`"browser": { "binding": "BROWSER" }`). */
  BROWSER: Fetcher;
  /** Owner-bound run ledger (`new_sqlite_classes` / Durable Object). */
  AGENT_RUNS: DurableObjectNamespace;
};

export type ShoppingAgentOrchestrationEnv = ShoppingAgentOrchestrationBindings & {
  /** HTTPS storefront origin; must match shopping-agent config. */
  MERCHANT_ORIGIN: string;
  /** Workers AI model id (optional; shopping-agent config default otherwise). */
  AGENT_MODEL?: string;
};

export const RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "stopped",
  "budget_exhausted",
  "failed",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/** UI/API-safe run record (no secrets, no live-view URLs). */
export type PublicAgentRun = {
  id: string;
  ownerId: string;
  status: RunStatus;
  goal: string;
  createdAtMs: number;
  updatedAtMs: number;
  sessionId: string | null;
  reply: string | null;
  events: PublicRunEvent[];
};

export type PublicRunEvent = {
  atMs: number;
  kind: string;
  message: string;
};

export type StartRunInput = {
  ownerId: string;
  goal: string;
  config?: Partial<ShoppingAgentConfig>;
};

export type RunPortsFactory = (ctx: {
  config: ShoppingAgentConfig;
  env: ShoppingAgentOrchestrationEnv;
}) => {
  model: import("../../shopping-agent/src/ports.js").ModelPort;
  launchBrowser: import("../../shopping-agent/src/ports.js").BrowserLauncher;
};