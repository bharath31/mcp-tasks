# Shopping agent orchestration (foundation)

Standalone runtime for **owner-bound** shopping agent runs: persist status/events in a Durable Object, drive the bounded `@nominee/shopping-agent` loop with injectable or production Workers AI + Browser Run ports. **Shopping only** — no Guardian approval, quote execution, or order placement.

## What is implemented

- `ShoppingAgentRunState` — per-owner DO (`AGENT_RUNS.idFromName(ownerId)`) with binding mismatch protection.
- Host-minted `AgentRunCredential` (digest stored; secret never written to events).
- `executeShoppingAgentRun` — real `runShoppingAgent` with `DEFAULT_PRODUCTION_PORTS` (`createWorkersAiModel` + `createPuppeteerLauncher`) or test doubles.
- Public run events derived from `ShoppingAgentEvent` via `shoppingEventToPublic` / `redactText`.
- Stale run cleanup RPC (`cleanupStale`).

## Host integration (shopping-live worker — not wired in this slice)

See `src/host-integration.ts`:

| Binding / var | Purpose |
| --- | --- |
| `AGENT_RUNS` | `ShoppingAgentRunState` DO class |
| `AI` | Workers AI |
| `BROWSER` | Browser Run |
| `MERCHANT_ORIGIN` | Trusted HTTPS storefront (must match agent config) |
| `AGENT_MODEL` | Optional model id override |

HTTP contract mirrors `demo/shopping-live/web` types: `POST /api/agent/start`, `GET /api/agent/:id`.

Wire exports in the worker entry (without editing deferred routes in this PR):

```ts
export { ShoppingAgentRunState } from "@nominee/shopping-agent-orchestration";
```

Use `ctx.waitUntil(executeShoppingAgentRun(...))` after session auth; mint credential on the host only.

## Blockers / unimplemented

- **Authenticated browser session** — `ORCHESTRATION_BLOCKERS.browserAuthenticatedSession`: puppeteer launcher does not inject customer session cookies or OAuth tokens. Agent cart actions against a signed-in merchant API are not demonstrated until the host adds a vetted cookie bootstrap.
- **Live Cloudflare** — CI uses fakes + Miniflare; production bindings are not invoked in tests.
- **Approval / execute** — explicitly out of scope.

## Tests

```sh
cd demo/shopping-agent-orchestration
npm ci
npm test
```

- Unit: credential hashing, event redaction leaks.
- Miniflare: cross-owner polling isolation, credential digest verification.
- Orchestrator: full agent loop with `shopping-agent` fakes, DO persistence.