# Shopping merchant ledger (Nominee slice)

Prototype **Cloudflare Durable Object** merchant ledger for Nominee shopping. It mirrors the trust model in [`packages/commerce`](../../packages/commerce/README.md) but stores state in **per-customer DO SQLite** (`SqlStorage`) instead of `node:sqlite` on a single host.

**Simulated payments only.** The fixture order provider never charges real cards and does not call live processors. Passing these tests does not imply production readiness.

## Trust boundaries

| Data | Source |
|------|--------|
| Actor (`customerId`, `agentId`, scopes, …) | Trusted host verifier on **every** call — never accept from raw client JSON |
| Catalog, unit prices | `SERVER_CATALOG` inside the ledger |
| Ship-to destination | `customerAccount.getAddress(customerId, addressId)` |
| Quote fields | Immutable snapshot at issuance (items, totals, destination, operation, revision, expiry) |
| Customer approval | Authenticated Worker calls `createTrustedMerchantHost(ledger).injectCustomerApproval` after `verifyCustomerApproval` — **not** exposed on the DO `fetch` RPC |

Every purchase requires **direct customer approval** (`requirement` is always `customer_verification`). Agents may build carts and quotes; execution stays blocked until the host injects verified approval.

## Layout

- `src/ledger.ts` — domain logic (Worker-compatible; no Node imports)
- `src/sql.ts` — `SqlDatabase` adapter for DO `SqlStorage` and a Node test double
- `src/merchant-do.ts` — `CustomerMerchantLedger` Durable Object (internal POST RPC only)
- `src/host.ts` — trusted-host facade for approval injection and execution
- `src/fixtures.ts` — simulated ports for local tests only

## One DO per customer

Production routing should use `env.MERCHANT_LEDGER.idFromName(customerId)` so each customer's carts, quotes, and executions live in one SQLite database inside their DO. The Worker must authenticate the caller, bind `x-nominee-customer-id`, and forward RPC to the stub.

**Hard prerequisite:** identity and approval proof are established in the Worker (Auth0 / Task Authority / passkey, etc.). A shared secret header alone does not prove customer approval. The DO rejects `injectCustomerApproval` RPC; only the Worker-side trusted host may call `ledger.injectCustomerApproval` after `verifyCustomerApproval`.

Port implementations (`customerAccount`, `verifyCustomerApproval`, `orderProvider`) cannot be Wrangler `env` bindings (they are functions). The Worker entry module must call `registerMerchantLedgerPorts(...)` at startup, wiring env-backed service fetches into those ports. Do not pass port objects from untrusted request bodies.

## Remaining integration work

- Wire Auth0 / Task Authority (or CIBA) into `verifyCustomerApproval` with operation-bound proof
- Attach a real Worker entrypoint, wrangler bindings, and northstar storefront (out of scope for this slice)
- Replace `createFixtureOrderProvider` with a restart-durable provider that honors idempotency keys
- Atomic coordination between address book mutations and open quotes (same gap as `packages/commerce`)
- Hyperdrive or external account service if addresses leave the DO

## Commands

```sh
npm --prefix demo/shopping-merchant run build
npm --prefix demo/shopping-merchant test
```