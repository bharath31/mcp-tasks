# Commerce cart milestone (incomplete)

This is not a storefront or checkout implementation. No HTTP handler, account/address port, quote, authorization, approval, order, payment or reconciliation is implemented. Do not use it for purchasing or as a production security boundary.

`createCartStore(path)` opens a single-host SQLite ledger. Callers must verify every actor using their own trusted server-side authentication and construct actor objects from the verifier, never request JSON. Agents use `{kind: "agent", agentId, pairwiseUserId, sessionId, customerId?, scopes}` and humans use `{kind: "human", customerId, scopes: []}`. Guest agents have no customerId. An account agent needs merchant-defined `cart:write` for account cart access or linking. Guest linking requires an exact verified agent/user/session tuple and a customer ID, and is atomic and idempotent. A human cannot claim a guest cart. Signed-in humans may access their own carts. IDs are not credentials. Account agents remain bound to the original agent and pairwise user; their session may change after linking.

Catalog prices are server-owned; cart input may contain only productId and bounded integer quantity. SQLite provides cross-process write serialization on one host; it is not a distributed ledger. `:memory:` is useful only for tests. The actor verifier, account identity lifecycle and local disconnect/revocation handling are not implemented here. Never expose these methods directly to untrusted clients.

Run `npm --prefix packages/commerce run build` and `npm --prefix packages/commerce test` with Node 22.13 or later. The built-in SQLite module is experimental in Node 22.
