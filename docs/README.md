# Docs map

Start with the [root README](../README.md). This page lists every guide, says which ones are current, and shows where the code lives.

## Guides

| Guide                                                   | Read it when                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [why-this-exists.md](why-this-exists.md)                | You want to decide whether you need this, or compare it with tool confirmation, workflow interrupts and CIBA. |
| [architecture.md](architecture.md)                      | You want the picture: the parts, one request from start to finish, and where to look in the code.             |
| [claude-code.md](claude-code.md)                        | You want to drive MCP Tasks from Claude Code, or need to know which sessions and modes support it.            |
| [deploy-cloudflare.md](deploy-cloudflare.md)            | You are deploying the full stack to your own Cloudflare, Auth0, FGA and Postgres.                             |
| [approval-policy.md](approval-policy.md)                | You are writing, testing, publishing or simulating a policy.                                                  |
| [approve.md](approve.md)                                | You want an Auth0-signed approval as a step in a durable workflow, without the service.                       |
| [approval-step-up-flows.md](approval-step-up-flows.md)  | You need every refund approval path (factors, failures, reject, owner, agents) and its test.                  |
| [security-model.md](security-model.md)                  | You need to know what is guaranteed, what is not, and which test proves each claim.                           |
| [interoperability.md](interoperability.md)              | You need to know which MCP hosts and features have been tested, and against what.                             |
| [demo-guide.md](demo-guide.md)                          | You want to run the scripted scenarios behind the security claims.                                            |
| [github-about.md](github-about.md)                      | You are publishing a copy of the repo and need its GitHub description, website and topics.                    |
| [`auth0/sdk/README.md`](../auth0/sdk/README.md)         | You are calling Task Authority from your app.                                                                 |
| [`auth0/service/README.md`](../auth0/service/README.md) | You are running Task Authority yourself.                                                                      |

App references: [Policy Desk README](../demo/policy-desk/README.md), [API](../demo/policy-desk/API.md), [architecture](../demo/policy-desk/ARCHITECTURE.md), [manual provisioning](../demo/policy-desk/PROVISIONING.md), [Refund Desk](../demo/refund-desk/README.md), [Refund Workflow](../demo/refund-workflow/README.md), and [approval UI components](../auth0/approval-ui/README.md).

Project guidance: [contributing](../CONTRIBUTING.md), [coding agents](../AGENTS.md), [security reporting](../SECURITY.md), and [MIT license](../LICENSE).

Historical background, not current instructions: [prd-approval-policy.md](prd-approval-policy.md). Its old-code observations and unchecked requirements are not a current implementation-status report.

## Repository layout

```text
auth0/                 This repo's custom approval code and Auth0 integrations (not Auth0-owned)
  service/             Task Authority: delegations, policy, approvals, atomic claim, audit (Postgres, FGA)
  sdk/                 @task-authority/sdk: the client your app uses, plus approve() for workflows
  approval-ui/         Reusable review components; embedded by Refund Desk
  actions/             Auth0 post-login Actions (assurance, MFA, factor enrolment)
  contracts/           Shared types between SDK and service
  fixtures/            Test identities and tuples
  tests/               Unit, contract, integration, protocol, security, e2e and interop suites
  tools/               task-authority CLI (policy init, check, explain, apply), boundary checker
demo/                  Customer apps (Refund Desk and Deploy Gate use only the SDK)
  policy-desk/         The full stack as one Cloudflare Worker: the hosted demo and the one-click deploy
  refund-desk/         A merchant-returns app with an MCP Tasks server (what `npm run local` runs)
  refund-workflow/     A Cloudflare Workflow gated by approve(), no service
  deploy-gate/         A second, unrelated action on the same SDK and service
tools/                 playground (offline policy), doctor (prerequisites), db-up (local Postgres)
wrangler.jsonc         The one-click deploy (Policy Desk, no tenant values)
```

`npm run lint` runs `auth0/tools/check-boundaries.mjs`. It fails if Refund Desk or Deploy Gate imports service internals or reads the service's tables, if the SDK imports disallowed dependencies (the proof verifier may also use `jose`), or if its scanner detects a secret pattern in tracked or non-ignored untracked files. Policy Desk is the exception: it hosts the service in the same Worker, so it imports it directly.

## Checks

`npm run check` builds, lints and runs every suite that needs only Node and the local Postgres. It is what CI's `test` job runs. CI's `fullstack` job also runs the browser suites, `npm run test:fullstack` and `npm run test:admin`, which need Chromium (`CHROMIUM_PATH`).

Live checks are opt-in. They use real services and are never run in CI. Each proves only what is listed:

| Command                                                                            | Needs                                         | Proves                                                                      |
| ---------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| `npm run doctor -- --url <origin>`                                                 | A deployed Worker                             | `/healthz` answers 200, so the Worker reaches its database.                 |
| `TASK_AUTHORITY_URL=... REFUND_DESK_URL=... npm run verify:live`                   | A separately deployed service and Refund Desk | Reachability, error contracts, origin policy, no secret leaks. Not sign-in. |
| `STRIPE_SECRET_KEY=sk_test_... node --import tsx demo/tools/verify-stripe-test.ts` | A Stripe test-mode key                        | The Stripe adapter: payment, idempotent refund, metadata reconciliation.    |
| `OPENFGA_BIN=/path/to/openfga npm run test:integration`                            | An OpenFGA server binary                      | The integration suites against real OpenFGA instead of the in-memory fake.  |

None of these proves interactive Auth0 sign-in or MFA on a live tenant. That is still checked by hand, as [interoperability.md](interoperability.md) records.
