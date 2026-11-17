# Simulated wallet (order provider)

Restart-durable **simulated** wallet backed by the same per-customer `SqlDatabase` as the merchant ledger. Implements `OrderProviderPort` only: integer USD minor units, no floats, no live charges.

## Not human approval

Debiting this wallet is **payment simulation**, not customer approval. The trusted host must independently verify quote identity, consent, and authorization **before** calling `place`. `provisionSimulatedWalletFunds` is a trusted-server-only helper for test/demo funding; it is not exposed on DO RPC or public HTTP.

## Idempotency and terms binding

- **`place` idempotency** is keyed by `idempotencyKey`. Replays must match the stored `terms_fingerprint`, which binds the full quote purchase snapshot: cart identity/version, line items, agent id, destination (canonicalized JSON), monetary breakdown, currency, `expiresAt`, and `requirement`. Volatile wall-clock checks are **not** applied on `reconcile`; an expired `expiresAt` in the snapshot still reconciles when the caller passes the same quote blob.
- **One debit per checkout operation:** `UNIQUE(customer_id, operation_id)` plus an explicit `sim_wallet_operation_debited` error prevents a second successful `place` for the same customer/operation under a different idempotency key.
- **Limitations:** The wallet does not verify human approval, host quote freshness, or ledger cart state. It only enforces stored terms and balances. Callers must not invoke `place` until the in-memory `Quote` matches the approved ledger revision.

## Reconciliation semantics

- **`reconcile` with no row** → `{ id: "", status: "absent" }` (distinct from a confirmed order id).
- **`reconcile` with a row** → `{ id }` when the quote matches stored terms; otherwise `sim_wallet_idempotency_conflict`.
- **Post-expiry recovery:** Same as any other replay—match the original snapshot; no expiry wall-clock gate in the wallet.

## Ledger fencing (atomic abandonment)

`createFencedSimulatedWalletLedgerSlice(db, customerId)` returns `orderProvider` plus `atomicAbandonAbsent` on the **same** `SqlDatabase` as the merchant ledger. `place` runs only when a `processing` `checkout_executions` row matches the quote id, customer, provider key, persisted quote terms fingerprint, and unexpired `expiresAt`; wallet debits reuse `placeSimulatedWalletOrderWithinTransaction` in that transaction. `atomicAbandonAbsent` synchronously rechecks wallet absence and marks the execution abandoned in one transaction — it does not infer safety from reconcile `absent` alone.

Merge the slice with `customerAccount` and `verifyCustomerApproval` at the DO host; do not wire from `port-env` until production ports exist.

## Integration

`CustomerMerchantLedger` wires `createFencedSimulatedWalletLedgerSlice` via `createMerchantLedgerPorts`. Trusted first bind calls `initializeTrustedSimulatedWalletOnce` with `SIMULATED_WALLET_INITIAL_BALANCE_MINOR` from `constants.ts` (never public top-up).
