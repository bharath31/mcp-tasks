# Shopping merchant ledger (Nominee slice)

Prototype **Cloudflare Durable Object** merchant ledger for Nominee shopping. It mirrors the trust model in [`packages/commerce`](../../packages/commerce/README.md) but stores state in **per-customer DO SQLite** (`SqlStorage`) instead of `node:sqlite` on a single host.

**Simulated payments only.** The fixture order provider never charges real cards and does not call live processors. Passing these tests does not imply production readiness.

## Trust boundaries

| Data                                       | Source                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Actor (`customerId`, `agentId`, scopes, …) | Trusted host verifier on **every** call — never accept from raw client JSON                                                                                  |
| Catalog, unit prices                       | `SERVER_CATALOG` inside the ledger                                                                                                                           |
| Ship-to destination                        | `customerAccount.getAddress(customerId, addressId)`                                                                                                          |
| Quote fields                               | Immutable snapshot at issuance (items, totals, destination, operation, revision, expiry)                                                                     |
| Customer approval                          | Authenticated Worker calls `createTrustedMerchantHost(ledger).injectCustomerApproval` after `verifyCustomerApproval` — **not** exposed on the DO `fetch` RPC |

Every purchase requires **direct customer approval** (`requirement` is always `customer_verification`). Agents may build carts and quotes; execution stays blocked until the host injects verified approval.

## Layout

- `src/ledger.ts` — domain logic (Worker-compatible; no Node imports)
- `src/sql.ts` — `SqlDatabase` adapter for DO `SqlStorage` and a Node test double
- `src/merchant-do.ts` — `CustomerMerchantLedger` Durable Object (internal POST RPC only)
- `src/host.ts` — trusted-host facade for approval injection and execution
- `tests/support/fixtures.ts` — simulated ports for Node/Miniflare tests only (never imported from `src/`)

## One DO per customer

Production routing should use `env.MERCHANT_LEDGER.idFromName(customerId)` so each customer's carts, quotes, and executions live in one SQLite database inside their DO. The Worker must authenticate the caller, bind `x-nominee-customer-id`, and forward RPC to the stub.

**Hard prerequisite:** identity and approval proof are established in the Worker (Auth0 / Task Authority / passkey, etc.). A shared secret header alone does not prove customer approval. The DO rejects `injectCustomerApproval` RPC; only the Worker-side trusted host may call `ledger.injectCustomerApproval` after `verifyCustomerApproval`.

Port implementations (`customerAccount`, `verifyCustomerApproval`, `orderProvider`) cannot be Wrangler `env` bindings (they are functions). Each Durable Object isolate builds ports in `merchantLedgerPortsFromEnv` (`src/port-env.ts`). In this slice that factory **always throws** (`merchant_ports_unconfigured`) until real account/approval/payment adapters are wired. Fixture ports live only under `tests/support/` (esbuild test bundles).

The DO `fetch` RPC is **internal** and **host-gated**: every operation (including binding) requires a matching `MERCHANT_HOST_INTERNAL_SECRET` header on the request. JSON `actor` fields are shape-checked only and **cannot authenticate** callers; the Worker must verify identity before forwarding. If the secret is unset, the DO returns **503 fail-closed** (`merchant_host_unavailable`) — not header-trust alone.

Host-only approval into DO state uses `hostInjectCustomerApproval` after the same transport gate. The DO still runs `verifyCustomerApproval` before recording approval (transport secret ≠ customer proof). Wire Auth0 / Task Authority into `verifyCustomerApproval` before any deploy.

**`trustedForAgentCheckout` on ship-to addresses** is snapshotted on each quote (see `fixture-alternate` in tests). It records whether the address was marked low-friction for agent checkout in the address book; **every purchase still requires direct customer approval** (`requirement` is always `customer_verification`), so untrusted addresses do not bypass human approval.

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
