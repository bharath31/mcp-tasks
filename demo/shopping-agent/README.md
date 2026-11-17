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

Wall-clock session budget uses `raceWithSessionBudget` around browser launch, each `model.run` call, and each `executeHostAction` (storefront navigation and DOM steps). That stops the **host** from waiting past the deadline; it does **not** cancel an in-flight Workers AI request, browser provider work, or a Puppeteer step that already started—merchant-side authority and provider limits remain mandatory. Late launch promises are closed via `discardLateBrowserSession`; late model and host action promises are discarded so their results are never fed back into the tool loop. Session teardown uses `boundBrowserClose` (capped wait, default 5s) so `browser.close()` cannot hang the host forever; an in-flight close may still complete at the provider after the host gives up.

Catalog and cart snapshots are scraped from the live storefront DOM and reconciled to host-owned product ids by **exact display name**. Grid order may change; nth-child selectors are not used. Displayed prices are informational only (`CATALOG_PRICE_DISCLAIMER`).

### Dependencies

`@cloudflare/puppeteer@2.0.1` is pinned to avoid seven high-severity transitive advisories pulled in by `1.4.0` (`basic-ftp`, `extract-zip`, `proxy-agent`). Run `npm audit` in this package after upgrades.

## Testing

`npm test` runs **Node-only** suites: fake model/browser ports (`tests/fakes.ts`), static HTML fixtures (`tests/fixtures/`), and adapter unit tests. These do **not** call live Cloudflare Workers AI or Browser Run. Integration against real bindings needs a Worker entrypoint and credentials outside this package.

## Commands

```sh
cd demo/shopping-agent
npm ci
npm test
npm run typecheck
```
