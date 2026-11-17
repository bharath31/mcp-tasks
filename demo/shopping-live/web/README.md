# Nominee consumer shopping (static frontend)

Deployable static UI for the Nominee consumer shopping simulator: Poppy on the left, merchant browser on the right, checkout gated on a connected shopping worker.

## Build and test

```sh
npm run build
npm test
npm run test:browser   # requires a local Chrome/Chromium
```

Output lands in `dist/`. Serve it as static assets; the Worker must implement the routes below.

## API contract (browser client)

| Method | Path                   | Body                                          | Purpose                                            |
| ------ | ---------------------- | --------------------------------------------- | -------------------------------------------------- |
| `GET`  | `/api/session`         | —                                             | Auth URLs, customer id, merchant wallet metadata   |
| `POST` | `/api/agent/start`     | `{ "goal": string }`                          | Start an agent run                                 |
| `GET`  | `/api/agent/{id}`      | —                                             | Agent status and **only** server-originated events |
| `GET`  | `/api/cart`            | —                                             | Cart snapshot for the signed-in customer           |
| `POST` | `/api/cart/items`      | `{ "productId": string, "quantity": number }` | Add or update a line (UI sends `quantity: 1`)      |
| `POST` | `/api/quote`           | `{}`                                          | Create a verified quote (full ledger snapshot)     |
| `GET`  | `/api/quote/{id}`      | —                                             | Re-fetch quote from ledger                         |
| `GET`  | `/api/checkout/resume` | —                                             | Resume quote / approval / agent after refresh      |
| `POST` | `/api/approval/start`  | `{ "quoteId": string }`                       | Begin Guardian CIBA push approval                  |
| `GET`  | `/api/approval/{id}`   | —                                             | Approval status (CIBA push; no default review URL) |
| `POST` | `/api/order/execute`   | `{ "quoteId": string }`                       | Execute after approval                             |

Authentication uses `loginUrl` / `logoutUrl` from `/api/session` only. The client stores no tokens in `localStorage`.

## Agent DOM compatibility

The merchant panel renders Stillroom-style markup compatible with `demo/shopping-agent/src/selectors.ts`:

- `#shop .grid` product grid
- `#shop .grid article button` add-to-cart controls
- `#cart .cart-list` cart lines

Additional hooks: `data-nominee-checkout-boundary`, `data-nominee-connection`, `data-nominee-agent-feed`.

## Unverified interactions

Until the Worker serves the routes above, the UI shows an honest unavailable state: sign-in links may be missing, cart/quote/approval/order buttons stay disabled, and agent activity is empty. No fixture fallback or simulated checkout runs in the browser.
