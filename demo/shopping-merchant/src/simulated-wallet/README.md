# Simulated wallet (order provider)

Restart-durable **simulated** wallet backed by the same per-customer `SqlDatabase` as the merchant ledger. Implements `OrderProviderPort` only: integer USD minor units, no floats, no live charges.

## Not human approval

Debiting this wallet is **payment simulation**, not customer approval. The trusted host must independently verify quote identity, consent, and authorization **before** calling `place`. `provisionSimulatedWalletFunds` is a trusted-server-only helper for test/demo funding; it is not exposed on DO RPC or public HTTP.

## Integration (future slice)

Wire `createSimulatedWalletOrderProvider(db, customerId)` inside the Durable Object when port-env is implemented. Do not import test fixtures from production bundles.
