/**
 * Host integration contract for demo/shopping-live/worker (wired later; not edited in this slice).
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
      "Cross-customer polling returns 404 (DO owner binding), not another user's run.",
    ],
  },
} as const;

export const UNIMPLEMENTED_HOST_CONSTRAINTS = [
  "Agent browser cart access uses host-minted capability cookies (see shopping-live worker); never customer session/JWT.",
  "No Guardian approval, quote execution, or order placement in this orchestration slice.",
  "Production Workers AI and Browser Run calls require deployed bindings; CI uses injectable ports only.",
] as const;
