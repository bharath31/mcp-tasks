# Stillroom Supply

A fictional customer shopping reference for Action Authority. The shop and its artwork are illustrative. No real purchases, identity, Poppy browser join, or payment integration are implemented here.

## Run

`npm ci` then `npm run dev`. The default UI makes runtime calls to the same-origin `/api` contract and does **not** fall back to a fixture if the service is missing. Visit `/?view=fixture` for a clearly labeled, non-interactive presentation with sample products; it has no simulated mutation engine. Run `npm run build` to validate the production build.

## Integrating the merchant service

Keep your existing Auth0 tenant, catalog, cart, order and payment backend. Install an appropriate Auth0/protocol adapter and connect the commerce Fetch handler to Next route handlers under `/api`. The typed browser boundary is `lib/client.ts`; requests follow the shared contract in `docs/plans/customer-agent-commerce.md`. Wire real catalog imagery, address selection, account sign-in, human checkout and checkout status polling. Do not trust IDs or browser-provided identity. Guard the commit-to-order boundary with server-owned quotes, your existing risk rules, ownership checks, durable idempotency and payment reconciliation. Preserve ordinary human checkout.

The review route is `/review/[id]`: connect the backend's `reviewUrl` to it and provide a server-verifiable, operation-bound customer verification and CSRF/origin protection. The server must reject agent sessions even if they are signed in. The client button is not proof of presence. The sample checks a `directCustomerVerification` capability only to avoid offering an unavailable button; the server is the security boundary. Fixture approval must be unavailable in live mode and explicitly identified. Quote changes invalidate approval; completion must revalidate it. The UI retry reuses the same idempotency key only while this page is open; a production integration should persist the key safely across reloads.

Poppy browser support in upstream Next.js SDK PR #2939 is open, not a released SDK feature. This example does not call proposed methods. Inject a compatible verified adapter explicitly; otherwise report Poppy unsupported. Never fall back from live to fixture identity, issue development cookies as production authentication, or expose tokens and approval URLs to model text. Agent-attested confirmation is not merchant-witnessed approval. Full UCP is not implemented; do not advertise it. No tenant setup runs here.

The simulator offers scenario instructions, not an actual agent. Select a scenario then use cart, address, quote and completion controls against the connected API; backend policy decides the outcome. A changed quote needs a fresh review, and retry uses the same key. Until the backend is wired, this is not a functional purchase path. Product illustrations in `public/` are original simple SVGs made for this example, not photographs.
