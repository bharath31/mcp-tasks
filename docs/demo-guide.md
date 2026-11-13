# Demo guide

This guide covers the **standalone Refund Desk** scenarios, not the hosted Policy Desk walkthrough. Scripted tests use local identity/provider fixtures; the standalone live path below remains unverified. Policy Desk has separate manual Auth0/FGA evidence and simulated payments—see [interoperability](interoperability.md) and [deploy your own](deploy-cloudflare.md).

## A. Scripted (executed in CI-style runs)

Prerequisites: Node 22, PostgreSQL reachable at `TEST_PG_ADMIN_URL` (default `postgres://dogfood:local-only@127.0.0.1:55432/postgres`; provide it with `docker run -d -p 55432:5432 -e POSTGRES_USER=dogfood -e POSTGRES_PASSWORD=local-only -e POSTGRES_DB=postgres postgres:17-alpine`).

```sh
npm ci
npm run test:security     # the eight PRD scenarios + faults, ingress, bypass, races
npm run test:protocol     # MCP Tasks 2026-07-28 conformance
node --import tsx --test auth0/tests/e2e/restart.test.ts   # real process SIGKILL + restart
# Same suites against a real OpenFGA server instead of the in-memory fake:
OPENFGA_BIN=/path/to/openfga npm run test:integration
```

| #   | Scenario                        | Test (`auth0/tests/e2e/scenarios.test.ts`)     | Expected decision                                                                                              |
| --- | ------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 0   | $150 exception, Morgan approves | "exception: Alice requests $150…"              | one refund; both layers in the timeline; one correlation id                                                    |
| 0   | $50 automatic                   | "automatic: $50 needs no human…"               | `approvalRequirement: none`, FGA still checked                                                                 |
| 1   | Wrong manager                   | "1 wrong manager…"                             | `not_authorized`; 0 claims; 0 provider calls                                                                   |
| 2   | Approver removed                | "2 approver removed…"                          | `approver_ineligible`; old approval superseded; fresh decision; one refund                                     |
| 3   | Grant revoked                   | "3 grant revoked…"                             | `delegation_revoked`; no refund                                                                                |
| 4   | Employee leaves                 | "4a" user-owned, "4b" org-owned                | 4a `owner_permission_lost`; 4b continues, former employee loses service reads                                  |
| 5   | Changed amount                  | "5 changed amount…"                            | `$150` approval never authorizes `$200` (`operation_changed` on replayed digest)                               |
| 6   | Disconnected client             | "6 disconnected client…" and `restart.test.ts` | task completes with no client; later `tasks/get` is accurate                                                   |
| 7   | Uncertainty                     | "7a/7b/7c"                                     | lost response reconciled by key (one refund); outages end `failed`/manual reconciliation; pending stays honest |
| 8   | Expired approval                | "8 expired approval…"                          | `approval_expired`; fresh decision required                                                                    |

## B. Live walkthrough (requires an Auth0 tenant, FGA, Stripe test key; **not executed here**)

1. Deploy this repo's [custom approval backend](../auth0/service/README.md) and [Refund Desk app](../demo/refund-desk/README.md) separately. Run `npm run verify:live` against both (`TASK_AUTHORITY_URL`, `REFUND_DESK_URL`).
2. Auth0: create an API for the MCP resource and one for Task Authority (enable RBAC; RAR for `task_authority_approval`); a SPA for the reviewer page; three M2M clients; Organizations `Northstar` and `Southridge`; deploy `auth0/actions/task-authority-approval.cjs` and `auth0/actions/task-authority-assurance.cjs`. Publish and activate a refund policy for `MCP_AUDIENCE`; an API registration alone does not configure policy. Create users Alice (requester), Morgan (manager), Mallory (Southridge), each with MFA.
3. FGA: load `auth0/service/fga/model.fga` and write the tuples in `auth0/fixtures/index.ts` (`BASE_TUPLES`) with your real user ids.
4. Set `PAYMENTS_MODE=stripe-test` with a `sk_test_` key, or leave `simulator` (the page banner shows which).
5. Use two browser profiles. Follow the prompts on the landing page ("Run the workflow"). Close the MCP client after the refund request to show disconnected execution.
6. "Inspect security" (needs `DEMO_MODE=1` and the operator token) shows the correlated timeline and drives the fixtures: emit the (synthetic) warehouse event, remove/restore the manager's permission, revoke the delegation, arm provider faults (simulator only). Each button prints the real response.
7. Wrong organization: open the review link signed in as Mallory.

Labels the UI must show and does: provider mode (Stripe test vs. simulator), warehouse events are a synthetic producer, demo mode on/off. **Success cannot be claimed for steps that used fixtures.**

## Evidence still owed from a live run

A recorded two-account walkthrough with real Auth0 login/MFA, a real Stripe test refund ID, and a screenshot of the correlated timeline.
