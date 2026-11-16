# Customer-authorized shopping: implementation brief

Status: agreed direction; implementation in progress. This is not a claim that the current hosted demo supports Poppy or shopping.

## Customer and outcome

The adopter is a merchant with an Auth0-backed custom/headless storefront, not an employee approval administrator. Their customers bring personal agents. The merchant wants agents to discover products, retain a cart across channels, use explicitly granted account access, and place an order without granting blanket access or replacing the merchant's commerce backend.

The first useful slice is a demonstrable storefront plus reusable server-side integration points. Show the customer a shop, their cart, an exact purchase review and an order receipt. Show the merchant (optionally, in a developer view) which customer and agent acted, which scopes/policy applied, which terms were accepted and whether the decision was agent-attested or witnessed directly by the merchant. Do not make an admin approval queue the main experience. No fabricated revenue, conversion, fraud or production-readiness claims.

Working umbrella name: **Action Authority**. Keep one monorepo; preserve existing Task Authority APIs/package names and refund examples during the transition. Do not rename the GitHub repository/domain or move all existing packages in this first slice. MCP is optional, not a prerequisite for shopping. Existing Auth0/FGA requirements for the old backend do not silently change.

## Protocol findings (2026-11-14)

Read the protocol source at commit `f04452be3f3257baef278d0bde3c54e0cb5fca79`:

- [Poppy 1.0 draft](https://personalagentprotocol.org/docs/spec) builds on 0.4 RC; it is not released 1.0.
- [Operations v3](https://personalagentprotocol.org/docs/extensions/operations) defines exact terms, immutable revisions, expiry, same-agent/user/account binding and at-most-once operation semantics. `approver: user` is the personal agent's assertion, not independently verified customer presence. For merchant-witnessed approval, the spec explicitly sends the person to the merchant's own app/site instead of pretending a Poppy approval proves it. Do not implement a competing approval wire format or advertise unsupported extensions.
- [UCP extension](https://personalagentprotocol.org/docs/extensions/ucp) assigns shopping/checkout/payment semantics to UCP. UCP checkout already has purchase approval; do not add a second Poppy Operations approval to a UCP checkout. A future UCP adapter must use its `requires_escalation` / `continue_url` flow. Full UCP is not in this first slice and must not be advertised.
- [nextjs-auth0 #2939](https://github.com/auth0/nextjs-auth0/pull/2939), head `58d631efcf1329c700a20c78369eeb6edad45beb`, is open. It provides discovery, browser join, human/guest-agent/signed-in-agent context and constrained session lifetime. It does not implement merchant checkout policy. [#2940](https://github.com/auth0/nextjs-auth0/pull/2940) is its cart example.
- [auth0-api-js #342](https://github.com/auth0/auth0-auth-js/pull/342), head `5cd394aefe4a1e99373a1ddd26fa28c8be3c2e71`, is open, under the `auth0-auth-js` monorepo. `verifyPoppyRequest` verifies the delegated signing chain, request binding, token hash, access token and agent binding. Its docs target 0.3, whereas current Operations v3 is newer. No claim of complete 1.0 compatibility without conformance testing. The SDK leaves rate limiting, idempotency and durable session/account records to the app.
- [auth0-server-js #343](https://github.com/auth0/auth0-auth-js/pull/343) is the alternative framework-neutral browser-join support, also open. Its limits/behavior are not identical to Next.js.
- CLI [#1754](https://github.com/auth0/auth0-cli/pull/1754), [#1755](https://github.com/auth0/auth0-cli/pull/1755), [#1767](https://github.com/auth0/auth0-cli/pull/1767), [#1768](https://github.com/auth0/auth0-cli/pull/1768), [#1770](https://github.com/auth0/auth0-cli/pull/1770) cover setup/config, agent registration, doctor and optional refresh-token Action. They are open/stacked work, not commands available in every installed CLI. No tenant mutations in this implementation task.

Local read-only research checkouts: `/tmp/mcp-shopping-research.OmzVQD/{protocol,nextjs-auth0,auth0-auth-js,auth0-cli}`. These paths are research aids, not build dependencies. Stable npm observed: nextjs-auth0 4.33.0; auth0-api-js 1.7.0. Do not silently call unreleased APIs on those versions or vendor upstream verifier code.

## First slice and boundaries

1. `packages/commerce/`: merchant-side domain integration, not another generic authorization engine. Server-owned catalog/prices, customer-owned carts, immutable checkout quotes, policy-driven approval requirements, a durable single-host demo ledger, order provider idempotency/reconciliation and explicit authorization/provider ports. Existing `auth0/sdk` is the seam to the full authority backend; do not clone its policy/delegation/quorum implementation. A local fixture authority is allowed only in explicitly labeled demo/test mode. A full-authority adapter must require explicit trusted context/delegation resolution; no invented organization or forwarded identity claims.
2. `integrations/poppy/`: typed adapter around the upstream verified request/context APIs; protocol discovery and Operations v3 parsing/rendering. No custom crypto replacement. Preserve agent identity separately from customer identity; absent/invalid Poppy evidence must not silently become a human request. Unsupported SDK versions fail closed with an actionable diagnostic. Normal browser auth can use stable Auth0 APIs; Poppy live mode is a separately gated compatibility path.
3. `examples/storefront/`: a Next.js reference shop and separately identified personal-agent simulator. Prefer a useful working flow over generic marketing. Default local mode may use fixture identity and simulated payments, but must say so prominently. Live configuration must never fall back to fixture identity/proof. Do not equate a browser button with a real passkey ceremony.
4. Root integration/docs/tests: reproducible install/run, merchant adoption guide, regression checks and a PR. Keep the old hosted demo/config intact; no deployment, real charge, real approval, secret/state readout or upstream PR modification.

## Shared HTTP contract for the first storefront

All amounts are safe integer minor units, currency `USD` initially. Prices/taxes/shipping are calculated server-side, never accepted from the agent. IDs alone are not credentials. JSON results, no-store for private state; errors include a stable code and safe message.

- `GET /api/catalog` -> `{ products: [{ id, name, description, priceMinor, currency, image? }] }`.
- `GET /api/session` -> `{ mode: "fixture" | "live", actor: { kind, customerId?, agentId?, scopes }, capabilities }`; no access tokens/cookies/proofs returned. Capabilities expose whether direct-customer verification and Poppy are actually configured.
- `POST /api/carts` -> `{ cart: { id, items, version } }` for the current verified actor.
- `GET /api/carts/:id` -> `{ cart }`, ownership checked.
- `PUT /api/carts/:id/items` body `{ items: [{ productId, quantity }] }` -> `{ cart }`; enforce bounded quantities/size and deterministic server pricing.
- `POST /api/carts/:id/quote` body `{ shippingAddressId }` -> `{ quote }`. Quote includes `id`, stable checkout `operationId`, immutable `revision`, `cartId`, `customerId` when signed in, item snapshots, subtotal/tax/shipping/total minor units, currency, destination label/id, `expiresAt`, and `requirement: "agent_confirmation" | "customer_verification" | "denied"`. Never expose another customer's address or account data.
- `POST /api/checkouts/:quoteId/complete` with `Idempotency-Key`; optional protocol approval is parsed only by the Poppy adapter. Return `{ status: "completed", order }`, `{ status: "approval_required", operation }`, `{ status: "customer_verification_required", reviewUrl }`, `{ status: "processing" }`, or a refusal. HTTP protocol-specific representation is an adapter concern; don't pass client-provided human/assurance fields into the service.
- `GET /api/checkouts/:quoteId` -> authorized quote/status view.
- `POST /api/checkouts/:quoteId/approve` is HUMAN-ONLY, with CSRF/origin protection and an injected server-verifiable operation-bound approval verifier. An agent browser/session/token is not a human. Fixture-only approval must be explicitly labeled and unavailable outside fixture mode. Persist the exact approved revision; completing still revalidates current conditions and ownership.
- `GET /api/orders` -> the signed-in customer's orders only.

New HTTP modules should use Fetch Request/Response so a thin Next.js catch-all can delegate to them. App state persists across HTTP requests. Demo persistence should survive a process restart (SQLite is acceptable for the single-host demo; don't claim multi-region readiness). Test-only memory stores must be named as such.

## Demonstration scenarios

- Browse and build a guest cart without account access; sign in only for account-bound capabilities. Link a guest cart only through verified same-agent/session continuity and explicit account ownership; never merge arbitrary cart IDs.
- A low-value cart (sample policy: up to $50 to a saved address) can use an allowed Poppy agent-attested confirmation. This is not a merchant-witnessed approval.
- A higher-value cart or a changed destination requires the actual customer on the merchant's trusted page. `approver=user`, `actor=human`, an LLM message and an agent-browser cookie cannot bypass this.
- A price, quantity, destination or expiry change invalidates the prior revision/approval. Requests within the same checkout retain the operation ID; a new purchase is a new operation.
- Retrying or racing completion does not create another simulated order. Unknown provider outcome remains processing/reconciliation-required, never a false failure followed by a blind new charge.
- Scope loss, local disconnection or ownership changes are checked before execution. Be honest about upstream token/grant revocation latency; don't promise immediate Auth0 revocation without evidence.

## Integration discipline

Parallel workers own separate worktrees and file prefixes. Commit locally; do not push, merge into the main checkout, open PRs, deploy, or launch more agents. The integration worker may cherry-pick the explicitly named lane commits into its isolated integration branch. Parent reviews actual diffs, runs final gates, pushes and opens the PR. Preserve untracked `demo/northstar/` and all pre-existing worktrees.

Local Docker/Postgres are currently unavailable; do not weaken old tests. New pure/unit and SQLite suites should run without those prerequisites; the existing full database/browser suites remain CI gates. Keep fixture, mocked-upstream, actual-upstream SDK and live-tenant evidence separate.
