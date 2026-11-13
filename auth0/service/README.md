# Task Authority: this repo's approval backend

Experimental, custom code for delegations, versioned policy, budgets, exact-operation approvals, execution claims, revocation and audit. **Not an Auth0 product or Auth0-hosted API.** Auth0 supplies identity and authentication evidence; FGA supplies current permissions; this backend combines them and stores its records in Postgres.

Policy Desk embeds this handler in **one Cloudflare Worker** alongside the refund app, MCP server and UI. The Node entry point is an alternative for running it separately from an application such as Refund Desk. See the [deployment diagrams](../../docs/architecture.md).

## Run the Node backend

From the repository root, after `npm ci`:

```sh
cp auth0/service/.env.example auth0/service/.env
# Fill in auth0/service/.env. These entry points do not load .env automatically.
node --env-file=auth0/service/.env --import tsx auth0/service/src/migrate-cli.ts
node --env-file=auth0/service/.env --import tsx auth0/service/src/server.ts
# In another terminal:
curl http://localhost:8788/healthz
```

If the variables are already exported, `npm run migrate:authority` and `npm run dev:authority` are equivalent. Do not use `MIGRATE_ON_START=1` with a restricted runtime role. Use an owner connection for migrations and appropriately restricted credentials at runtime.

`src/http.ts` exports `createHandler({ store, config })`, a Web-standard request handler. `src/server.ts` adapts it to Node 22+. Policy Desk supplies its own database adapter and sandbox-scoped configuration instead.

Contract: [`openapi.json`](openapi.json), generated from routes and Zod schemas. `node --import tsx auth0/tools/generate-openapi.ts --check` checks drift. Structured service errors are `{ code, message, correlationId, retryable, details? }`. The generated OpenAPI lists routes and request schemas, but uses generic success-response objects and does not fully model DPoP or forwarded-subject requirements. Use the SDK/contracts and policy documentation alongside it, not as a complete generated-client specification.

## Dependencies and configuration

| Need                                            | Notes                                                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres                                        | Owns the `authority` schema. A separately deployed customer app must not receive its credentials or grants. Policy Desk deliberately shares one database/runtime role across app and backend schemas. |
| Auth0 tenant                                    | Issuer and API audience; backend M2M permissions; human organization identity and configured approval Actions. Creating an Auth0 API registers an audience, not a hosted approval backend.            |
| FGA store with [`fga/model.fga`](fga/model.fga) | OpenFGA-compatible checks at authorization boundaries, with no service-side decision cache. Node configuration accepts an API token; Policy Desk additionally supports FGA client credentials.        |
| `TENANT_ACTIONS_JSON`                           | Operator floor: requester/approver relations, optional auto-approval ceilings and permitted human-direct `resourceServers`.                                                                           |
| Published policy                                | Active version for each resource server. Unknown or unconfigured actions deny unless an explicit supported policy says otherwise.                                                                     |
| `ALLOWED_ORIGINS`                               | Explicit browser reviewer origins for a separately hosted page.                                                                                                                                       |

`TENANTS_JSON` configures multiple Node-backend tenants, each with a distinct issuer. Policy Desk uses a different resolver: a backend tenant per visitor sandbox generation under one Auth0 issuer.

Use separate API, executor, auditor and policy-administration credentials. The executor needs `claims:create`, `outcomes:report` and `operations:read`; policy administration uses `policies:write` / `policies:read`. Protected backend operations also require the relevant `trusted_backend` FGA relation. The app's `approvalAssertion: "none"` cannot lower the policy or operator floor.

## Behavior

- Requests execute in database transactions. Claim/revocation paths lock delegation, operation and approval in order. FGA failures return retryable `authorization_unavailable` without a new claim.
- A retry by the same executor during a live lease can recover the same claim. Expired or revoked uncertain claims require reconciliation. `not_submitted` is an executor attestation that can release the claim; it is not independently verified provider evidence.
- Routine session tiers require policy-specified fresh MFA and, by default, DPoP. Per-operation tiers require fresh operation-bound assurance via a service challenge or RAR. A DPoP-bound eligible reviewer can reject without a second factor. See [approval policy](../../docs/approval-policy.md).
- Default separation of duties excludes initiators/owners. Explicit owner approval is restricted to a user-owned delegation, one reviewer and operation-bound WebAuthn. Agent tokens cannot decide.
- Database quotas cover open delegations/approvals and claims per day. The backend's request-rate limiter is in-process; Policy Desk adds edge and Postgres limiters.
- The SDK normalizes operation `status` to storage lifecycle for executors while retaining `outcomeStatus` for user-facing clients. Reads require an authorized initiator, reviewer or backend.

Policy administration includes publishing, validation, activation, simulation and shadow versions. Reviewer surfaces include queue, leases, challenges and batch decisions. CIBA is explicit escalation only. Provider events (`provider-events:write`) support reconciliation alerts; the digest endpoint produces an eligibility-filtered payload, not notification delivery.

## Migrations and tests

Migrations `0001`–`0007` cover the schema, role hardening, function search paths, CIBA, policies/budget holds, reviewer sessions/decisions and provider events. Use the migration runner rather than applying a selected subset.

`npm run test:integration` needs Postgres and exercises the HTTP handler. `OPENFGA_BIN=/path/to/openfga npm run test:integration` selects a real local OpenFGA server instead of the fixture where supported. See [checks](../../docs/README.md#checks).

## Limits and evidence

The handler is deployed inside the hosted Policy Desk demo. That does not validate every standalone path: CIBA, RAR and on-behalf-of exchange remain local-fixture-tested only. The hosted demo's manual Auth0/FGA checks and tested MCP hosts are recorded in [interoperability](../../docs/interoperability.md).

There is no general retention job, external security review or production SLA. Policy Desk has a demo-specific cleanup function that intentionally removes expired sandbox records. Claims do not guarantee exactly-once external effects: use provider idempotency and reconciliation. A compromised app holding provider credentials can bypass the backend. See the [security model](../../docs/security-model.md).
