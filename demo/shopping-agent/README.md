# Shopping agent core (bounded browser)

Standalone module for a **real Workers AI** planner driving **real Cloudflare Browser Run** (Puppeteer) against a **single trusted HTTPS merchant origin**. The model only calls a fixed host-owned tool surface; the host validates every action, owns selectors, enforces checkout boundaries, and does not expose Live View or secrets to the model.

This package is **not wired** into Policy Desk or a public HTTP entrypoint yet.

## Public interface

- `runShoppingAgent({ config, request, model, launchBrowser })` — multi-turn tool loop with budgets.
- `createWorkersAiModel(ai)` — Workers AI `AI.run` adapter (`WorkersAiBinding`).
- `createPuppeteerLauncher(binding, config)` — Browser Run session with `guardrails.allowedDomains` and host request interception.
- Zod schemas: `shoppingAgentConfig`, `hostAction`, `shoppingRequest`.

## Safety notes

Session guardrails (exact merchant hostname) are the primary network control. Host-side `setRequestInterception` is defense in depth and **does not** fully cover subresource edge cases or merchant API authorization. The agent **never** clicks checkout controls and returns `checkoutAllowed: false` in cart snapshots.

## Commands

```sh
cd demo/shopping-agent
npm ci
npm test
npm run typecheck
```