# Security model

This describes the **custom approval backend implemented in this repository**, not a shipped Auth0 product. It is a source-and-test description, not an external security review. Auth0 supplies identity/authentication, FGA supplies permission checks, and this code owns approval records and claims.

The default hosted path is Policy Desk's `APPROVAL_MODE=authority`. The separate [`approve()` experiment](approve.md) has different guarantees and does not inherit the service's FGA, policy or claim checks.

## Controls exercised by the tests

Paths below are relative to the repository root. Tests against a local identity provider establish the implementation's behavior under those fixtures, not compatibility with every live tenant.

| Control                                              | Mechanism                                                                                                                                                                                                  | Evidence                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Identity is verified                                 | Signed tokens; organization and subject checks. The Node service selects a configured issuer; Policy Desk resolves a sandbox and verifies its caller. Body fields cannot substitute for verified identity. | `auth0/tests/service/lifecycle.test.ts`, `registration-authz.test.ts`; `demo/policy-desk/tests/security.test.ts` |
| Delegation is bounded                                | Owner type, agent, scope, actions, resource prefixes, numeric ceilings, expiry and immutable provenance                                                                                                    | `auth0/tests/service/lifecycle.test.ts`, `security.test.ts`                                                      |
| User-owned authority depends on current owner rights | FGA requester permission rechecked at claim; organization-owned grants use different lifetime rules                                                                                                        | `auth0/tests/e2e/scenarios.test.ts` (4a/4b)                                                                      |
| Approval covers an exact operation                   | Digest binds tenant, organization, delegation, key, action, scope, resource, canonical arguments and business-state version                                                                                | `auth0/tests/service/lifecycle.test.ts`, `security.test.ts`                                                      |
| Approval assurance is policy-specific                | Session MFA/DPoP for session tiers; fresh operation-bound challenge or RAR for per-operation tiers; replay tracking. DPoP-bound rejection does not need another factor.                                    | `auth0/tests/service/reviewer-policy.test.ts`; `demo/policy-desk/tests/flows.test.ts`                            |
| Reviewer eligibility is current                      | FGA rechecked at decision and claim; default separation of duties, with an explicit restricted owner-approval option                                                                                       | `auth0/tests/service/owner-approval.test.ts`; scenario 2                                                         |
| Claims serialize authorization                       | Database locks and a unique live-claim constraint; same-claim recovery or reconciliation for uncertain execution                                                                                           | `auth0/tests/service/security.test.ts`; `auth0/tests/e2e/restart.test.ts`                                        |
| Revocation and claim ordering is explicit            | Both take the delegation lock; already-claimed work is in flight, not reported as reversed                                                                                                                 | `auth0/tests/service/security.test.ts`                                                                           |
| Authorization dependency errors fail closed          | FGA/datastore errors prevent a new claim and produce retryable failures                                                                                                                                    | `auth0/tests/service/security.test.ts`                                                                           |
| Audit records resist ordinary mutation               | UPDATE/DELETE triggers; audit field allow-list; tests check fixture tokens are not recorded                                                                                                                | `auth0/tests/service/migration.test.ts`, `security.test.ts`                                                      |
| Separate customer apps cannot access backend state   | Restricted database credentials and source-boundary checks for Refund Desk / Deploy Gate                                                                                                                   | `auth0/tests/service/security.test.ts`; `auth0/tools/check-boundaries.mjs`                                       |

Facts and actor/policy snapshots are recorded separately from the operation digest and checked on registration replay. Facts remain assertions from trusted application code; they are not independently verified business truth.

## Attacker assumptions and outcomes

| Attempt                                                                     | Expected control / limit                                                                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent supplies `approved: true` or forged elicitation input                 | Tool/input schemas confer no approval authority; only the backend's decision record satisfies the claim check                                                             |
| Caller reads another user's Refund Desk task                                | Unknown and unauthorized task IDs return indistinguishable errors                                                                                                         |
| Wrong-organization reviewer decides                                         | Refused; internal audit records the reason                                                                                                                                |
| Human initiator approves their own direct request                           | Refused with `initiator_cannot_approve`                                                                                                                                   |
| Owner approves their own agent                                              | Allowed only by `self_approval: "owner"`, for a user-owned delegation and single-reviewer operation, with current requester permission and fresh operation-bound WebAuthn |
| Agent presents a delegated reviewer token (`act` / `sub_profile: ai_agent`) | Refused as a reviewer on REST, batch, lease, challenge and CIBA decision paths                                                                                            |
| Caller asserts no approval is needed                                        | Cannot lower the active policy or operator floor                                                                                                                          |
| Reviewer reuses an operation-bound token for a different approval           | Binding/replay checks refuse it; an identical retry of an already-recorded decision can be idempotent                                                                     |
| Workers race or crash                                                       | Recover the same claim or reconcile; duplicate external effects still depend on provider idempotency                                                                      |
| Caller forges warehouse ingress in Refund Desk                              | Signature, timestamp and schema checks reject it; duplicate receipts apply once                                                                                           |
| Caller reaches Refund Desk operator controls                                | Require demo mode and operator authentication; absent otherwise                                                                                                           |
| Another browser origin calls the standalone service                         | Explicit CORS allow-list; CORS is not server-to-server authorization                                                                                                      |

## Revocation is not rollback

Revocation committed before a claim denies it. A claim committed first is **in flight**; retry after revocation requires reconciliation. The service cannot retract an external side effect. MCP cancellation is cooperative and does not imply reversal of a dispatched refund.

FGA checks request `HIGHER_CONSISTENCY` and the service caches no decisions. A relationship change can still race a check or a subsequent provider call. Do not describe revocation as stopping every in-flight action immediately.

## Deployment boundaries

- **Separate Node deployment:** Refund Desk and Task Authority can use separate processes, databases and credentials. A customer database role without backend grants cannot read its tables.
- **Policy Desk:** app and approval backend share a Worker and runtime database role. Source modules and schemas are separate, but this is not credential isolation from a compromised Worker.
- **Audit retention:** ordinary runtime writes cannot update/delete append-only tables. However, Policy Desk intentionally grants a narrowly scoped `SECURITY DEFINER` cleanup function that deletes demo tenant records, temporarily disabling the relevant triggers within its transaction. Sandbox audit is therefore **not tamper-proof against the runtime or permanent**. Aggregate usage survives cleanup. Standalone deployments have no general retention job.

## Known limits

1. **A compromised executor with provider credentials can bypass the service.** Adapter grant checks are in-process controls, not provider-enforced restrictions.
2. **A claim is not exactly-once execution.** Same-claim recovery can still lead to repeated dispatch attempts. Use a stable provider idempotency key and read-only reconciliation. A lying `not_submitted` report can release authority for a new claim.
3. **Outcome reports are executor attestations.** Report uncertain dispatch as `unknown`, not a proven failure. Provider webhook reconciliation is only as trustworthy as the ingress signature verification and forwarding backend.
4. **Business facts are trusted inputs.** The backend cannot establish that an amount, balance or destination reflects the real business state. The app must validate it and recheck state before dispatch.
5. **Limits have different scopes.** Backend open-record and daily-claim quotas are in Postgres; its request limiter is in memory. Policy Desk adds Postgres fixed windows and an optional configured edge limiter; neither is a production capacity guarantee.
6. **Live evidence is selective.** Policy Desk's email OTP login, WebAuthn step-up, DPoP, Organizations and FGA have manual demo-tenant evidence. CIBA, RAR, OBO and the separate `approve()` proof path are not verified on live Auth0. Claude Code has local-stack evidence, not hosted OAuth end-to-end evidence. See [interoperability](interoperability.md).
7. **Browser storage differs.** Refund Desk uses the React Auth0 integration with in-memory tokens. Policy Desk configures `auth0-spa-js` with `cacheLocation: "localstorage"`; do not claim all browser tokens stay in memory. XSS and compromised browser sessions remain important risks, even with DPoP.
8. **CIBA grants can be lost.** If a single-use provider token cannot be verified or recorded, it grants no authority; recovery may require a fresh approval request. A CIBA denial is not a signed proof of the denier's identity.
9. **Forwarded subject DPoP is the app's responsibility.** The backend verifies `X-Task-Authority-Subject` signature/claims, but does not re-verify its original DPoP proof. The forwarding resource server must do that, as Policy Desk does. Delegated agent tokens cannot become human grantors or reviewers.
10. **No production-hardening claim:** no external security review, fuzzing, load/soak evidence, general retention policy, key-rotation procedure, multi-region guarantee or SLA. Secret scanning and audit allow-lists reduce specific leakage risks; they do not prove arbitrary application facts/logs contain no sensitive data.

Report vulnerabilities through [SECURITY.md](../SECURITY.md), using only your own sandbox for any hosted-demo report.
