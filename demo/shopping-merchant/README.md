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
| Customer approval | `injectCustomerApproval` after `verifyCustomerApproval` returns true — **no public HTTP `/approve` route** |

Every purchase requires **direct customer approval** (`requirement` is always `customer_verification`). Agents may build carts and quotes; execution stays blocked until the host injects verified approval.

## Layout

- `src/ledger.ts` — domain logic (Worker-compatible; no Node imports)
- `src/sql.ts` — `SqlDatabase` adapter for DO `SqlStorage` and a Node test double
- `src/merchant-do.ts` — `CustomerMerchantLedger` Durable Object (internal POST RPC only)
- `src/host.ts` — trusted-host facade for approval injection and execution
- `src/fixtures.ts` — simulated ports for local tests only

## One DO per customer

Production routing should use `env.MERCHANT_LEDGER.idFromName(customerId)` so each customer's carts, quotes, and executions live in one SQLite database inside their DO. The Worker must authenticate the caller, bind `x-nominee-customer-id`, and forward RPC to the stub.

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