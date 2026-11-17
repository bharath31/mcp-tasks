/**
 * Host integration contract for demo/shopping-live/worker (see shopping-live/worker/wrangler.jsonc).
 */

export const WRANGLER_AGENT_RUN_SNIPPET = `{
  "durable_objects": {
    "bindings": [
      {
        "name": "AGENT_RUNS",
        "class_name": "ShoppingAgentRunState",
        "script_name": "shopping-live"
      }
    ]
  },
  "ai": { "binding": "AI" },
  "browser": { "binding": "BROWSER" },
  "vars": {
    "MERCHANT_ORIGIN": "https://your-storefront.example"
  }
}` as const;

export const HOST_HTTP_CONTRACT = {
  start: {
    method: "POST",
    path: "/api/agent/start",
    body: { goal: "string (1-2000 chars)" },
    auth: "Customer session cookie (host-owned)",
    response: {
      id: "run uuid",
      status: "pending | running | ...",
      events: "PublicRunEvent[]",
    },
    notes: [
      "Host mints AgentRunCredential server-side; never accept client-supplied secrets.",
      "Use ctx.waitUntil(executeShoppingAgentRun(...)) for async execution.",
    ],
  },
  poll: {
    method: "GET",
    path: "/api/agent/:id",
    auth: "Customer session cookie",
    response: "PublicAgentRun",
    notes: [
      "Resolve ownerId from session, then AGENT_RUNS.idFromName(ownerId).",
      "Poll requires the same parent customer session (innerSid) that started the run.",
      "Cross-customer polling returns 404 (DO owner binding), not another user's run.",
    ],
  },
} as const;

export const UNIMPLEMENTED_HOST_CONSTRAINTS = [
  "Agent browser cart access uses host-minted capability cookies (Path=/api/agent-browser); never customer session/JWT.",
  "Storefront agent mode calls /api/agent-browser/* (not /api/cart/*) when only the capability cookie is present.",
  "No Guardian approval, quote execution, or order placement in this orchestration slice.",
  "Production Workers AI and Browser Run calls require deployed bindings; CI uses injectable ports and local Chromium proofs.",
] as const;
