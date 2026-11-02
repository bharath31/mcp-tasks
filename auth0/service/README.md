# Task Authority service (proposed; reference implementation)

A separately deployed, multi-tenant authorization lifecycle service for long-running agent tasks. **Not an Auth0 product or API.** It owns delegation grants, exact-operation approvals, the atomic authorize-and-claim, revocation, and the security audit. It evaluates versioned approval policy and budgets. The customer application schedules tasks and calls providers through a claimed operation.

Contract: `openapi.json` (generated from the route table and Zod schemas; `node --import tsx auth0/tools/generate-openapi.ts --check` fails on drift). Errors are always `{ code, message, correlationId, retryable, details? }`.

## Run it

```sh
cp .env.example .env            # fill in; see below
npm run migrate:authority       # applies migrations/ (or MIGRATE_ON_START=1)
npm run dev:authority           # Node adapter around the Web-standard handler
curl localhost:8788/healthz
```

`src/http.ts` exports `createHandler({ store, config })`, a plain `(Request) => Response`; `src/server.ts` is only a Node adapter. Runtime: Node 22, PostgreSQL via `pg`.

Migrations: `0001_init` (schema, triggers), `0002_harden_roles` (RLS; revokes Supabase API roles when present), `0003_pin_function_search_path`, `0004_ciba`, `0005_policy` (versions, snapshots, budget holds), `0006_approval_policy` (leases, reviewer sessions, DPoP and decisions), `0007_provider_events` (reconciliation and digest throttles).

## What you must provide

| Need                                                | Notes                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL, **separate from any customer database** | Role that owns the `authority` schema. The customer app must not be granted it. A role with no grants gets `42501` (tested).                                                         |
| Auth0 tenant                                        | Issuer + audience for the API; M2M clients carry `permissions`; humans use Organizations (`org_id`).                                                                                 |
| FGA store with `fga/model.fga`                      | Relations are checked on every protected decision, never cached. OpenFGA HTTP API.                                                                                                   |
| Operator floor (`TENANT_ACTIONS_JSON`)              | Maps an action to the FGA relations for requesting and approving, plus an optional `autoApproveCeilings` guard and the `resourceServers` that human-direct registrations may target. |
| `ALLOWED_ORIGINS`                                   | Only the reviewer page's origin(s).                                                                                                                                                  |

M2M permissions: `delegations:create|read|revoke`, `operations:register|read|cancel`, `approvals:request|read`, `claims:create`, `outcomes:report`, `audit:read`. Give the executor only `claims:create`, `outcomes:report`, `operations:read`. Each client must also be `trusted_backend` for the organization in FGA.

## Behaviour worth knowing

- One transaction per request; lock order delegation → operation → approval. FGA is called inside the lock and any failure is `authorization_unavailable` (HTTP 503, retryable), with nothing claimed.
- Claim recovery: same operation + same executor within the lease returns the same claim; after the lease or revocation it returns `reconcile_required`. `not_submitted` (customer attests the provider has nothing) releases it for a fresh claim.
- Approval decisions require a human token with multi-factor `amr` and fresh `auth_time`. Routine policy accepts a verified DPoP session; high value policy requires operation binding through RAR or a service-issued challenge and a single-use decision id. Claims `amr`/`auth_time` may be namespaced (`https://task-authority.example/…`; override with tenant `claimNamespace`).
- Quotas per tenant: open delegations, open approvals, claims per day (database counters); request rate per caller per minute (in-process).

## Limits (honest list)

No deployment was performed. In-process rate limit. No retention/purge job (audit and idempotency rows persist). The Node adapter supports multiple tenants using `TENANTS_JSON`. Auth0/FGA SaaS behaviour is unverified; the FGA client targets the OpenFGA API and was verified against OpenFGA v1.8.4. See `docs/security-model.md`.

## Tests

`npm run test:integration` (needs PostgreSQL) covers this service through the HTTP handler. `OPENFGA_BIN=… npm run test:integration` runs the same tests against a real OpenFGA server.

## Versioned policies and reviewers

Publish and activate an explicit policy before accepting operations. Unconfigured
APIs and unknown actions deny by default. Use a separate M2M token with
`policies:write` to manage documents; `policies:read` can inspect them. The
application token cannot lower policy using `approvalAssertion: "none"`.
See [policy setup, budgets and outcomes](../../../docs/approval-policy.md).

New surfaces include `PUT/GET /v1/policies/{resourceServer}`, validation,
activation, simulation and shadow mode; the eligible approval queue, reviewer
leases, operation challenges and batch decisions; explicit CIBA escalation;
provider reconciliation (`provider-events:write`); and a coalesced digest.
`resourceServer` is the API identifier and is independent of delegation scope.

The operation-status endpoint renders the six user-facing states in `status`
and `outcomeStatus`, with the storage lifecycle in `lifecycleStatus`. The SDK
normalizes `status` to the lifecycle for executor compatibility, retaining
`outcomeStatus` for user-facing clients. Status reads are restricted to verified
initiators, current reviewers and authorized backends.
