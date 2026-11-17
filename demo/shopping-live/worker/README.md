# Nominee shopping live Worker

Fail-closed Cloudflare Worker host for the Stillroom consumer shopping UI (`../web`). Customer sign-in uses Auth0 authorization code + PKCE with server-held tokens in HttpOnly cookies; cart and quote state live in a per-customer Durable Object and the shared merchant ledger DO.

## Required secrets and bindings

Set these before a real deploy (never commit values):

| Binding / secret                | Purpose                                                |
| ------------------------------- | ------------------------------------------------------ |
| `SHOPPING_AUTH0_DOMAIN`         | Auth0 tenant hostname (DNS only, no URL)               |
| `SHOPPING_API_AUDIENCE`         | API identifier for access token verification           |
| `SHOPPING_AUTH0_CLIENT_ID`      | Confidential SPA/backend client id                     |
| `SHOPPING_AUTH0_CLIENT_SECRET`  | Token exchange at `/oauth/token`                       |
| `SHOPPING_SESSION_SECRET`       | HMAC key for oauth transaction cookies and session ids |
| `MERCHANT_HOST_INTERNAL_SECRET` | Worker→merchant DO internal RPC                        |
| `CUSTOMER_STATE`                | Durable Object namespace binding                       |
| `MERCHANT_LEDGER`               | Merchant ledger DO binding                             |

Optional vars (see `wrangler.jsonc`):

- `SHOPPING_PUBLIC_ORIGIN` — canonical origin when the Worker sits behind multiple hostnames (defaults to request origin)
- `SHOPPING_MERCHANT_SHIPPING_ADDRESS_ID` — merchant-owned simulated destination id (must exist in the account port)
- `SHOPPING_BROWSER_AGENT_ID` — server-assigned agent id for human browser carts (not client-supplied)
- `SHOPPING_MERCHANT_WALLET_MODE` / `LABEL` — reported to the UI in `/api/session`

## Auth and session

- Login: `GET /auth/login` starts PKCE; callback `GET /auth/callback` exchanges the code, verifies the access token (issuer, audience, `shopping:customer` scope), and stores the token server-side in `CustomerHostState` (browser receives an opaque `nsh_sid` cookie only).
- Logout: `POST /auth/logout` with same-origin `Origin` and `x-nominee-csrf` revokes the session and clears cookies (`GET` returns **405**).
- Bounded sessions: at most 8 active sessions per customer; access tokens re-verified on each API call.

## API

| Route                      | Auth           | Notes                                                                                                                                |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/session`         | optional       | Login/logout URLs, wallet metadata                                                                                                   |
| `GET /api/cart`            | session        | Merchant cart snapshot                                                                                                               |
| `POST /api/cart/items`     | session + CSRF | Prices from server catalog only                                                                                                      |
| `POST /api/quote`          | session + CSRF | Merchant-owned shipping address id                                                                                                   |
| `POST /api/approval/start` | session + CSRF | Requires pinned CIBA env; **503** when unconfigured                                                                                  |
| `GET /api/approval/:id`    | session        | Poll + ledger bridge via production merchant DO                                                                                      |
| `POST /api/order/execute`  | session + CSRF | **503** unless `SHOPPING_GUARDIAN_EXECUTE_ENABLED` is explicitly set after operator confirms live Guardian rendering and Auth0 proof |

## Limitations (honest)

- **No live validation yet:** Miniflare tests mock Auth0/CIBA outbound; they do not call a live tenant or exercise real Guardian push/display.
- Enable `SHOPPING_GUARDIAN_EXECUTE_ENABLED` only after live Guardian transaction display and Auth0 CIBA response proof are verified in the target deployment.
- Integration tests may bind production `CustomerMerchantLedger`; routine unit tests still use the fixture DO bundle under `tests/support/`.
- Simulated wallet funding runs on first DO bind only through trusted host init (not public funding hooks).

## Develop and test

```sh
npm --prefix demo/shopping-live/web run build
npm --prefix demo/shopping-live/worker test
```

Deploy (after secrets and DO migrations):

```sh
npm --prefix demo/shopping-live/web run build
npx wrangler deploy -c demo/shopping-live/worker/wrangler.jsonc
```
