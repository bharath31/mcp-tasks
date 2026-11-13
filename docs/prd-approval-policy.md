# Historical PRD: Channel-agnostic approval policy

> **Archived design context, written 2026-10-15—not current setup instructions or an implementation checklist.** References to “today,” source line numbers, deficiencies and provider limits below describe that investigation, not the current code. Preserve them as rationale; use [approval-policy.md](approval-policy.md), [architecture.md](architecture.md) and [interoperability.md](interoperability.md) for the current implementation and verified integrations. Auth0 plan entitlements and limits must be checked against current provider documentation before deployment.

## Current implementation versus this proposal

- The versioned policy evaluator, SDK guard, REST/CLI parity, budgets, reviewer queue/leases, per-operation challenges, session tiers, batch API, simulation, shadow mode, templates, provider-event reconciliation and digest payload are implemented.
- CIBA is explicit escalation, not the default approval channel. The earlier front-channel RAR problem is not a description of the current service-challenge or confidential PAR paths.
- Policy Desk has a limited policy console and co-locates the custom backend with the app in a Worker; the diagram below is a logical/separate-deployment design, not the default hosted topology.
- Policy Desk makes routine approvals per-operation by default. Session MFA remains supported by the generic policy model. DPoP-bound rejection can omit MFA. Explicit owner approval is now supported for restricted user-owned single-reviewer operations.
- A general policy editor, role-diverse quorum, conditional FGA approver limits, Event Streams integration and Terraform provider remain future work. The unchecked boxes below are historical requirements, **not** an assertion that all are still missing or implemented exactly as proposed.
- “Task Authority” is the backend implemented in this repository, not an Auth0 product. Claims coordinate authorization; they do not guarantee exactly-once external effects. Live-test limitations remain in [interoperability.md](interoperability.md).

---

| Field    | Value                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------- |
| Status   | Archived proposal; see current-status note above                                                         |
| Date     | 2026-10-15                                                                                               |
| Scope    | `auth0/service` (Task Authority), `auth0/sdk`, `auth0/actions`, `demo/refund-desk`                       |
| Replaces | CIBA as the default approval channel (CIBA is kept as an escalation channel)                             |
| Related  | [`architecture.md`](architecture.md), [`security-model.md`](security-model.md)                           |
| Reminder | This was a proposal for repository-owned code, not an Auth0 product roadmap or shipped approval feature. |

## 1. Summary

Approval policy today is spread across five places (customer code, an environment variable, FGA tuples, hard-coded defaults and Auth0 Action code). It is decided by the calling application and reachable only through the MCP path. The default asynchronous approval channel, CIBA, turns every operation into a push notification to one named person.

This PRD makes approval a property of the **operation**, not of the **channel**:

1. **Enforce** at the resource server's side-effect boundary with one guard (`authority.protect`) that every transport goes through: MCP, REST, CLI, UI and jobs.
2. **Decide** in Task Authority from business facts the caller supplies, using a versioned, per-resource-server policy that the service evaluates. Callers may raise a requirement, never lower it.
3. **Approve** as a server-side record bound to the operation digest and consumed at claim time. The client never carries the approval, so any client works.
4. **Assure** reviewers with tiered Auth0 primitives (session MFA, WebAuthn-first step-up, PAR + RAR transactional authorization). Push notifications become an escalation path, not the default.
5. **Configure** in one place: a policy document per resource server, editable as code or in a console, with simulation and shadow mode before enforcement.

## 2. Problem statement

A support lead approving refunds requested by an AI agent gets one CIBA push notification per refund, with a 64-character description, addressed to them by name, expiring in 5 minutes. At desk volume this is either throttled by Auth0 (5 push notifications per user per minute) or trains the reviewer to tap "approve" without reading, which is the MFA-fatigue pattern that push-bombing attacks exploit. Separately, the policy that decides whether approval is needed is computed by whichever client calls the service. A CLI or raw API path written by another team can therefore skip approvals that the MCP path enforces.

Who is affected:

- **Reviewers** (support leads, managers): notification overload, decisions without context.
- **Tenant administrators**: cannot change thresholds, budgets or approver rules without a code change and redeploy.
- **Security and compliance owners**: approval coverage depends on which code path a request took, and the audit trail cannot show that one policy was applied uniformly.

Cost of not solving it: approval either becomes a rubber stamp (security loss) or a bottleneck (agents stall, customers wait). Both undermine the reason to have a human in the loop.

## 3. Background and findings

### 3.1 Why CIBA is the wrong default here

CIBA is Auth0's primitive for asynchronous human-in-the-loop approval ([Asynchronous Authorization](https://auth0.com/ai/docs/intro/asynchronous-authorization)). Its documented use cases all have the **resource owner approving their own agent's action** at low volume. A support desk is the opposite: a reviewer pool, high volume, routine decisions.

| Finding                                                                                                                                                                                                                                            | Evidence                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| CIBA addresses one named subject via `login_hint`; the demo hard-codes one reviewer.                                                                                                                                                               | `demo/refund-desk/src/server.ts:101`                                                                                                    |
| Fan-out to N reviewers means N pushes per operation. CIBA Core defines no cancel endpoint, so N-1 prompts dangle after one reviewer decides.                                                                                                       | CIBA Core 1.0                                                                                                                           |
| Auth0 routes a CIBA request with expiry of 300 s or less to push, and 301 s to 72 h to email. We send no `requested_expiry`, so we get the 300 s push default, while our approval window is 30 min. Re-requesting after expiry sends another push. | [Configure CIBA](https://auth0.com/docs/get-started/applications/configure-client-initiated-backchannel-authentication); `config.ts:48` |
| Auth0 rate-limits push notifications to 5 per user per minute, SMS to 10 burst and 1 per hour sustained, WebAuthn challenges to 15 per minute.                                                                                                     | [Rate limits, Additional MFA rate limits](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy)  |
| The binding message is capped at 64 characters from a restricted character set. A reviewer sees an action name, a resource id and a digest prefix, not the customer, items or reason.                                                              | `auth0/service/src/ciba.ts:54-56`                                                                                                       |
| Auth0's own guidance: "Avoid MFA fatigue by enforcing push notification rate limits."                                                                                                                                                              | [MFA playbook](https://auth0.com/docs/secure/attack-protection/playbooks/mfa-playbook)                                                  |
| A CIBA `access_denied` is recorded as a rejection by `reviewer_subject` without any token proving who denied it.                                                                                                                                   | `auth0/service/src/approvals.ts:557-562`                                                                                                |

### 3.2 Removing CIBA alone does not fix it

The portal path also forces one MFA ceremony per decision: decision tokens are single-use (`auth0/service/migrations/0001_init.sql:179`), bound to one approval and digest, at most 5 minutes old (`config.ts:50`), and the approval Action offers push as a factor (`auth0/actions/task-authority-approval.cjs:27`). Forty refunds means forty challenges, and with Guardian push, forty notifications.

### 3.3 The portal binding probably does not work against a real Auth0 tenant

The reviewer page sends `authorization_details` on a front-channel `/authorize` from `auth0-spa-js` (`demo/refund-desk/web/review.ts:95-97`). Auth0 requires `authorization_details` to be sent to `/par` ([Authorization Code Flow with RAR](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow/authorization-code-flow-with-rar)), and PAR supports confidential clients only ([Authorization Code Flow with PAR](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow/authorization-code-flow-with-par)). It also needs the Highly Regulated Identity add-on. The Action reads the details from `event.request.query` (`task-authority-approval.cjs:14`) instead of the documented `event.transaction.requested_authorization_details`. The repo already states these flows were never verified against a live tenant.

### 3.4 Why Auth0 token issuance cannot be the policy decision point

1. **Tokens are checked once and used many times.** A post-login Action runs at issuance. A CLI with a one-hour token can make fifty refunds; Auth0 sees one event.
2. **Machine callers never reach post-login.** `client_credentials` triggers only the `credentials-exchange` Action. No user means no MFA and no step-up.
3. **Auth0 cannot see business facts** (refundable balance, cumulative spend, customer velocity) without calling our API, which makes our API the decision point anyway.
4. **Scopes are binary.** A `refund:large` scope covers any amount until expiry. RAR transactional tokens are per-transaction but must be **carried by the client**, which only works when the approver is the caller.

### 3.5 Step-up and approval are different mechanisms

|                     | Step-up                                                                                                    | Approval (four-eyes)                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Who                 | The caller proves stronger assurance                                                                       | A different person decides                                     |
| Timing              | Synchronous, seconds                                                                                       | Asynchronous, minutes to hours                                 |
| Standard            | RFC 9470: `401` with `error="insufficient_user_authentication"`, `acr_values`, `max_age`; any OAuth client | None in OAuth                                                  |
| Universal shape     | `401` challenge                                                                                            | `202 Accepted` plus an operation resource                      |
| Where approval sits | In the caller's token                                                                                      | **On the server**, bound to the digest, consumed at claim time |

MCP Tasks is MCP's binding of the `202`-plus-operation pattern. Nothing about approval needs to be MCP-specific.

### 3.6 Where policy is configured today

| What                                    | Where                                                     | Who can change it                 |
| --------------------------------------- | --------------------------------------------------------- | --------------------------------- |
| Business threshold ($100 auto)          | `NORTHSTAR_POLICY`, `demo/refund-desk/src/policy.ts:10`   | Developer, redeploy               |
| Whether approval is required            | Caller's `approvalAssertion`, `workflow.ts:46`            | Whoever writes the caller         |
| Tenant ceiling and approver relation    | `TENANT_ACTIONS_JSON`, `auth0/service/src/config.ts:5-16` | Service operator, restart         |
| Who may approve                         | FGA tuples, `auth0/service/fga/model.fga`                 | FGA administrator                 |
| Approval TTL, decision max age          | `DEMO_DEFAULTS`, `config.ts:45-51`                        | Developer, redeploy               |
| Reviewer assurance (factors, freshness) | `auth0/actions/*.cjs`                                     | Auth0 administrator, editing code |

The tenant guard only raises the requirement when a numeric argument exceeds `autoApproveCeilings` (`operations.ts:239-244`). Below the ceiling, a caller asserting `"none"` is auto-approved. Refunds can only be created through `/mcp` (`demo/refund-desk/src/app.ts:65-121`), and the provider adapter's grant check is in-process (`payments.ts:30`).

## 4. Goals

| #   | Goal                                                                                                         | Measured by                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| G1  | **Channel parity.** Identical operation and principal produce an identical decision on every transport.      | Parity test suite: MCP, REST and CLI produce identical decisions, reason codes and audit events |
| G2  | **Policy no longer depends on the caller.** The service computes the requirement; callers can only raise it. | Security test: caller asserting `"none"` for a rule-matched operation gets `approval_required`  |
| G3  | **No notification per approval by default.** Routine and high-value tiers use in-browser assurance.          | Notifications per approved operation: 0 for tiers 1 and 2; at most 1 per escalation             |
| G4  | **Policy changes without code.** An administrator changes a threshold, budget or tier without a deploy.      | Time from policy edit to enforcement under 1 minute, with a new immutable version in the audit  |
| G5  | **Bypass is detectable.** A provider-side side effect without a matching claim raises an alert.              | Reconciliation test: an injected unclaimed refund is flagged within one reconciliation cycle    |

## 5. Non-goals

| Non-goal                                                                                     | Why                                                                                                                   |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Making Auth0 token issuance the policy decision point                                        | It cannot see per-call facts or machine calls (section 3.4).                                                          |
| A general-purpose policy language (Rego, full Cedar)                                         | A constrained document with CEL conditions covers thresholds, budgets and tiers, and stays analysable for simulation. |
| Notification delivery (Slack, email, mobile push) as a product feature                       | We emit events and expose a queue; delivery is the customer's integration. A reference digest notifier is P1.         |
| Preventing side effects taken outside the resource server (provider dashboards, leaked keys) | Impossible from here. We detect them (G5) instead.                                                                    |
| Removing CIBA                                                                                | It stays as an opt-in escalation channel for paging and owner-approves-own-agent cases.                               |
| Production SLAs, load testing, multi-region                                                  | This remains a reference implementation.                                                                              |

## 6. Personas and user stories

**Tenant administrator (security or operations owner)**

- As a tenant administrator, I want to define approval rules once per API, so that MCP, REST, CLI and internal jobs are governed identically.
- As a tenant administrator, I want to start from a template ("Refunds", "Production deploy", "Data export"), so that I get safe defaults without writing rules from scratch.
- As a tenant administrator, I want to simulate a policy change against recent operations, so that I know how many approvals, denials and budget overruns it would have produced before I enforce it.
- As a tenant administrator, I want to run a new policy in shadow mode, so that I can compare its decisions with the live policy without affecting users.
- As a tenant administrator, I want agents and humans treated differently where I say so, so that an agent's $150 refund can need approval while a support lead's does not.
- As a tenant administrator, I want an unknown action to be denied by default, so that a new endpoint is never accidentally unprotected.

**Reviewer (support lead, manager)**

- As a reviewer, I want pending approvals in a queue I am eligible for, so that I work through them instead of reacting to notifications.
- As a reviewer, I want to see the full operation (customer, items, amount, reason, history) before deciding, so that my approval is informed.
- As a reviewer, I want routine approvals to need MFA once per review session, so that I am not challenged forty times an hour.
- As a reviewer, I want high-value approvals confirmed with Touch ID or a security key in the same browser, so that I never approve from a lock-screen card.
- As a reviewer, I want to claim an item before reviewing it, so that two reviewers do not duplicate work.
- As a reviewer, I want to approve up to five similar high-value items with one confirmation, so that batches are efficient without becoming blind.

**Integrating developer (customer application)**

- As a developer, I want one guard around each protected mutation, so that I do not reimplement approval per transport.
- As a developer, I want a standard `202 Accepted` with an operation URL when approval is needed, so that any HTTP client, including scripts, can wait or poll.
- As a developer using the CLI, I want `--wait` to block until the operation is decided, so that scripts behave predictably.
- As a developer, I want a standard RFC 9470 challenge when my own assurance is insufficient, so that existing OAuth libraries can step up automatically.

**Security and compliance owner**

- As a compliance owner, I want every decision stamped with the policy version, rule id and actor chain, so that I can prove which policy applied.
- As a security owner, I want to be alerted when a provider side effect has no matching claim, so that bypasses are found quickly.

## 7. Proposed solution

### 7.1 Architecture

```text
 Clients: MCP client | CLI | raw HTTP | internal UI | scheduled job
            \          |        |           |           /
             v         v        v           v          v
 +------------------------------------------------------------+
 | Customer resource server (e.g. refund-desk)                |
 |   transport adapters: /mcp  /v1/refunds  ...               |
 |            \             |            /                    |
 |             v            v           v                     |
 |   authority.protect(action, facts)    <- enforcement point |
 |             |                                              |
 |   executor (only holder of provider credentials)           |
 +-------------|----------------------------------------------+
               | SDK (M2M)
               v
 +------------------------------------------------------------+
 | Task Authority service                <- decision point    |
 |   policy store (versioned, per resource server)            |
 |   CEL rule evaluation + budgets (stateful)                 |
 |   approvals queue, leases, decisions, claims, audit        |
 +------------------------------------------------------------+
        |                     |                       ^
        v                     v                       |
   Auth0 (identity,      FGA (who may           provider webhooks
   assurance, agents)    approve, limits)       -> reconciliation
```

Administration happens in the policy store, through a console or `task-authority policy apply`.

### 7.2 Outcome contract (identical decision, transport-specific rendering)

| Decision            | REST / raw API                                                | CLI                                    | MCP                             | Jobs / webhooks                           |
| ------------------- | ------------------------------------------------------------- | -------------------------------------- | ------------------------------- | ----------------------------------------- |
| `allow`             | `201`, executed through a claim                               | exit 0                                 | task `completed`                | `201`                                     |
| `step_up_required`  | `401` + RFC 9470 `WWW-Authenticate` (`acr_values`, `max_age`) | re-login with `acr_values`, then retry | MCP authorization challenge     | not possible: becomes `approval_required` |
| `approval_required` | `202` + `Location: /v1/operations/{id}` + `reviewUrl`         | prints link; `--wait` polls            | task `working` + status message | `202` + callback on decision              |
| `deny`              | `403` + reason code                                           | exit 1 + reason code                   | task `failed`                   | `403`                                     |

### 7.3 Policy model

One document per resource server (keyed by the Auth0 API identifier), immutable once published, identified by `version`.

```yaml
resource_server: https://api.northstar.example
version: 2026-10-15.1
unknown_action: deny
actions:
  refund:create:
    arguments: { amount_minor: int, currency: string, customer_id: string }
    approvers: { relation: refund_approve, on: organization }
    rules:
      - id: agent-small-within-budget
        when: actor.type == "agent" && args.amount_minor <= 10000
        then:
          allow:
            budget:
              per: delegation
              window: 24h
              max_amount_minor: 50000
              max_count: 20
      - id: over-100
        when: args.amount_minor > 10000
        then: { approve: { tier: routine, ttl: 30m } }
      - id: over-1000
        when: args.amount_minor > 100000
        then: { approve: { tier: high_value, quorum: 2 } }
      - id: human-large-step-up
        when: actor.type == "human" && args.amount_minor > 100000
        then: { step_up: { acr: mfa, max_age: 300 } }
    default: { approve: { tier: routine } }
tiers:
  routine: { assurance: session_mfa, max_age: 3600, dpop: required }
  high_value:
    assurance: per_operation
    factors: [webauthn-platform, webauthn-roaming]
    batch_max: 5
```

Evaluation semantics:

- **Inputs:** `action`, `resource`, `args` (canonical arguments), `facts` (caller-supplied business facts, recorded in the audit), `actor` (from the verified token: `type` is `agent` when the token carries an agent `act` claim or `sub_profile: ai_agent`, else `human` or `service`), relations from FGA, and aggregates (budgets) from service state.
- **The transport is never an input.** It is caller-asserted and untrusted.
- **Combining:** every matching rule contributes an outcome. `deny` beats everything; otherwise the strictest outcome wins (`approve` with higher quorum or tier > `step_up` > `allow`). Several `step_up` requirements merge to the strictest `acr` and smallest `max_age`.
- **Budgets (decision D2):** reserve at registration, capture at claim, release on any terminal outcome without a side effect. An `allow` with a budget matches only if the operation's amount fits in the remaining budget after existing holds; the hold is written in the same transaction as the operation, so concurrent registrations cannot overspend. The claim converts the hold into consumption. Rejection, cancellation, expiry and a `not_submitted` outcome release it; a `provider_outcome_unknown` keeps it until reconciled (fail closed). A hold expires after `budget_hold_ttl` (default 15 min); if it lapsed before the claim, the claim re-checks the budget and, when it no longer fits, the operation is re-decided by the remaining rules instead of executing. When the budget is exhausted, the rule drops out and the remaining rules or `default` decide. A budget with `max_amount_minor` counts a declared `int` argument (`amount_arg`, defaulting to a declared `amount_minor` or `amountMinor`); publish fails when none is declared. Because the `default` decides once the rule drops out, publish also rejects an action whose `default` is an unbudgeted `allow` while a rule carries a budget, and at evaluation an over-budget request that would otherwise fall to such a default is denied as `budget_exhausted`.
- **Caller assertion:** `approvalAssertion` stays in the API and can only raise the outcome.
- **Actor type (decision D1):** `actor.type` changes an outcome only through a rule that names it. There is no built-in agent penalty. Templates ship agent-specific rules, publish warns when no rule for an action distinguishes agents from humans, and an actor whose type cannot be established is evaluated as `agent` (fail closed).
- **Conditions** are CEL expressions: they cannot loop, run in bounded time, and can be statically checked against the declared argument schema at publish time.

### 7.4 Approval mechanism and assurance tiers

| Tier          | Trigger (policy)                   | Reviewer assurance (Auth0)                                                                                                                                                                                                                                                                                          | Decision binding                                                       | Notifications      |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------ |
| 0. none       | `allow`                            | none                                                                                                                                                                                                                                                                                                                | none; claim still required                                             | none               |
| 1. routine    | `approve` tier `routine`           | MFA at session start (`acr_values`/`max_age`), short session (`api.session.setExpiresAt`/`setIdleExpiresAt`), DPoP-bound token                                                                                                                                                                                      | Service binds the digest from the decision request body                | optional digest    |
| 2. high value | `approve` tier `high_value`        | Per-operation step-up, WebAuthn first. With the HRI add-on: PAR + RAR [transactional authorization](https://auth0.com/docs/secure/highly-regulated-identity/transactional-authorization-with-authorization-code-flow), `consent_policy: transactional-authorization-with-mfa`, our review UI as the consent surface | RAR `authorization_details` with up to 5 `{approval_id, digest}` pairs | none (in-browser)  |
| 3. escalation | Tier 2 item unclaimed past its SLA | CIBA to the on-call approver: push for paging, email channel for windows over 300 s                                                                                                                                                                                                                                 | Existing CIBA binding, rejection attribution fixed                     | one per escalation |

Tier fields are enforced by the service at decision time. `factors` is matched against the signed `amr` values (standard or namespaced claim) and applies to approvals only; the shipped assurance Action adds the completed factor's method name to `amr`, while a bare `mfa` cannot distinguish webauthn from otp and so fails closed (`factor_not_satisfied`) for any tier that lists factors. `dpop: optional` admits a bearer session token (session tiers default to `required`; per-operation tiers require DPoP only when set to `required`). `idle_timeout` is a policy duration (default `15m`) after which a session reviewer must re-authenticate. When tiers combine, `idle_timeout` takes the shortest and `factors` the intersection.

Rejections need only tier-1 assurance (a rejection grants nothing). Approvals are always checked again at claim time against current FGA eligibility, delegation status and digest, as today.

### 7.5 Auth0 primitives used

| Need                             | Primitive                                                                                                                                                                                                                       | Constraint                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Low-friction strong factor       | [WebAuthn device biometrics and security keys](https://auth0.com/docs/secure/multi-factor-authentication/fido-authentication-with-webauthn/configure-webauthn-device-biometrics-for-mfa) via `api.authentication.challengeWith` | User needs one other enrolled factor first                                    |
| Per-transaction approval binding | PAR + RAR transactional authorization                                                                                                                                                                                           | Confidential client (reviewer backend), Enterprise + HRI, max 5 entries, 5 KB |
| Own UI as consent surface        | `consent_policy: transactional-authorization-with-mfa`, `event.transaction.linking_id`                                                                                                                                          | PAR only; not CIBA                                                            |
| Session-level assurance          | `acr_values`, `max_age`, `api.multifactor.enable`, `api.session.setExpiresAt` / `setIdleExpiresAt`                                                                                                                              | Interactive flows only                                                        |
| Token theft resistance           | [DPoP](https://auth0.com/docs/secure/sender-constraining/demonstrating-proof-of-possession-dpop)                                                                                                                                | Resource server must enable sender constraining                               |
| Agent vs human attribution       | [Agent as Principal](https://auth0.com/docs/ai-agents-mcp/agent-as-principal): `act`, `sub_profile`, `event.agent`                                                                                                              | Early Access                                                                  |
| Eligibility sync                 | [Event Streams](https://auth0.com/docs/customize/events/create-an-event-stream): `organization.member.role.deleted`, `organization.member.deleted`                                                                              | Identity events only                                                          |
| Escalation                       | CIBA (push at 300 s or less, email up to 72 h)                                                                                                                                                                                  | 5 push per user per minute                                                    |

## 8. Requirements

### P0: must have

**P0-1. Enforcement guard in the SDK (`authority.protect`).** One function wraps a protected mutation: it registers the operation with facts, maps the decision to the outcome contract (7.2) and executes only through `authorizeAndClaim`.

- [ ] The refund-desk MCP tool and a new `POST /v1/refunds` route both use the guard, with no approval logic outside it.
- [ ] A parity test runs the same operation and principal through MCP, REST and the CLI and asserts identical decision, reason code, policy version, rule id and audit events.
- [ ] Given a REST caller and an operation needing approval, when it posts, then it gets `202` with `Location: /v1/operations/{id}` and a `reviewUrl`, and no side effect occurs.
- [ ] `GET /v1/operations/{id}` returns status `pending_approval | approved | rejected | completed | failed | denied` to the initiator and the reviewers only.

**P0-2. Service-evaluated requirement.** `operations.register` accepts `facts`; the service evaluates the active policy for the resource server and action.

- [ ] Given a rule requiring approval, when a caller asserts `approvalAssertion: "none"`, then the requirement is `human`. This is a security test.
- [ ] Given no policy for the action, then the outcome is `deny` (`unknown_action: deny`) unless the tenant explicitly sets `unknown_action: approve`.
- [ ] Every decision's audit event carries `policyVersion`, matched `ruleIds`, `actor` (including the `act` chain), and the facts used.

**P0-3. Versioned policy document.** Stored per tenant and resource server; immutable versions; one active version.

- [ ] `task-authority policy validate|apply|list|activate` works against the service API.
- [ ] Publish rejects CEL that does not compile, references undeclared arguments, or produces a tier that is not defined.
- [ ] Activating a version takes effect for new registrations within 60 seconds; existing operations keep the version they were registered under.

**P0-4. Budgets.** `allow` rules may carry a budget per delegation, per principal or per organization over a rolling window, by amount and by count.

- [ ] Concurrent registrations cannot overspend: a hold is checked and written in the registration transaction, and converted to consumption in the claim transaction.
- [ ] Rejection, cancellation, expiry and `not_submitted` release the hold; `provider_outcome_unknown` keeps it until reconciled.
- [ ] Given a hold lapsed and the budget no longer fits at claim time, the claim is denied with `budget_exhausted` and the operation is re-decided by the remaining rules; no side effect occurs.
- [ ] Given a budget is exhausted, the rule stops matching and the next strictest outcome applies.

**P0-5. Human-direct mode.** A human calling the API directly (CLI via device flow, internal UI) can register an operation without an agent delegation.

- [ ] The operation records the human as initiator and `actor.type = human`.
- [ ] Separation of duties still holds: the initiator cannot approve their own operation.

**P0-6. Reviewer queue and leases.** `GET /v1/approval-requests?status=pending` returns only approvals the caller is currently eligible to decide (FGA). `POST /v1/approval-requests/{id}/lease` claims an item for a short period.

- [ ] Two reviewers leasing the same item: one succeeds, one gets `409`.
- [ ] A reviewer who loses the approver relation cannot list, lease or decide.

**P0-7. WebAuthn-first reviewer step-up and the Action fixes.**

- [ ] `task-authority-approval.cjs` challenges `webauthn-platform` first, `webauthn-roaming` and `otp` as alternatives, and never `push-notification` for tiers 1 and 2.
- [ ] Actions read `event.transaction.requested_authorization_details`, not `event.request.query`.

**P0-8. CIBA demoted and fixed.**

- [ ] CIBA is used only by escalation, never by default request paths; `CIBA_REVIEWER_SUBJECT` is removed from the demo default.
- [ ] `startCiba` sends `requested_expiry` derived from the approval window, so the channel choice is explicit.
- [ ] A CIBA denial is recorded with `approver_id = null`, `via: ciba_denied`, and the hinted subject only as `reviewer_hint`, never as a verified actor.

### P1: should have

**P1-1. Simulation.** `policy simulate --version X --since 30d` replays recorded operations (facts are stored) and reports counts by outcome, by rule and by tier, plus the operations whose outcome would change.

**P1-2. Shadow mode.** A version can be marked `shadow`: evaluated on every registration, logged with its would-be outcome, never enforced.

**P1-3. Tier 1 session assurance.** Decisions in the routine tier accept a DPoP-bound reviewer token with multi-factor `amr` and `auth_time` within the tier's `max_age`. Per-reviewer velocity limits apply (default 60 decisions per hour).

**P1-4. Batch decisions (tier 2).** `POST /v1/approval-requests/decisions` with up to 5 approvals, one token whose `authorization_details` lists each `{approval_id, operation_digest}`, consumed once for the set. All must be for the same action; each item must be individually shown in the UI before confirmation.

**P1-5. Reviewer backend for PAR + RAR.** A confidential-client reviewer backend performs PAR for tier 2 when the tenant has the HRI add-on; without it, tier 2 uses the service's own digest binding with a WebAuthn step-up.

**P1-6. Provider reconciliation.** Ingest provider refund webhooks; any refund without a matching claim raises `bypass.detected` in the audit and an alert hook.

**P1-7. Templates.** Built-in templates for refunds, production deploys and data exports, each with safe defaults.

**P1-8. Reference digest notifier.** Coalesced per-reviewer digest ("7 awaiting, oldest 12 min") with a queue link, rate-limited, carrying no authority.

### P2: future considerations

- **P2-1.** Console UI for policy editing with diff, simulation results and one-click activate. Design the API (P0-3, P1-1) so the console is a pure client.
- **P2-2.** Per-approver limits as FGA conditions (CEL, evaluated with request context), such as "may approve up to $5,000".
- **P2-3.** Event Streams consumer that supersedes leases and pending approvals when `organization.member.role.deleted` arrives.
- **P2-4.** An Agent-as-Principal Action rule that denies issuing tokens for the approval audience or RAR type to any agent-linked client.
- **P2-5.** Terraform provider for policy documents.
- **P2-6.** Quorum greater than 2 and role-diverse quorum ("one manager plus one finance").

## 9. Contract changes (sketch)

| Surface                                    | Change                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `operations.register`                      | add `facts`; `approvalAssertion` optional and raise-only; response adds `decision`, `ruleIds`, `policyVersion` |
| `GET /v1/operations/{id}`                  | operation status for initiator and reviewers                                                                   |
| `PUT/GET /v1/policies/{resourceServer}`    | publish, list, activate, shadow; `POST .../simulate`                                                           |
| `GET /v1/approval-requests?status=pending` | eligibility-filtered queue                                                                                     |
| `POST /v1/approval-requests/{id}/lease`    | short reviewer lease                                                                                           |
| `POST /v1/approval-requests/decisions`     | batch of up to 5 (P1)                                                                                          |
| SDK                                        | `authority.protect(action, factsFn, execute)`; transport renderers for REST, MCP Tasks and CLI                 |
| Contracts                                  | `channel: "ciba"` removed from `RequestApproval`; escalation configured in policy                              |

These are breaking changes to the prototype's contract. There are no external consumers to migrate.

## 10. Security considerations and trade-offs

- **Tier 1 is weaker than per-operation binding, by design.** A compromised reviewer browser inside an MFA'd, DPoP-bound session could approve routine items in bulk until the session idles out. Mitigations: per-item ceiling defined by the tier boundary, per-reviewer velocity limits (P1-3), short idle timeout, audit of decision rate. Tier 2 keeps per-operation binding. Where the tier boundary sits is a tenant decision.
- **Policy administration becomes a privileged surface.** Publishing and activating require a separate permission (`policies:write`), are audited with the actor and diff, and cannot lower a tenant-level floor set by the service operator.
- **Callers cannot choose the governing policy.** `resourceServer` selects the policy, relations, budgets and tiers, so a human-direct registration is accepted only for an action the operator has configured and only for a resource server that entry lists (`resourceServers`); a human token also needs an explicit `operations:register` grant. Delegated registrations name the resource server from the trusted backend's configuration. This closes the path by which a caller could pick a more lenient published policy (G2).
- **Facts are caller assertions.** As today, the service trusts business facts. The audit records them so that a lying caller is attributable, and reconciliation (P1-6) catches the most damaging case.
- **Actor type comes from the verified token only.** If Agent as Principal is not enabled, actor type falls back to the delegation model: operations registered under an agent delegation are `agent`. If neither source establishes it, the actor is evaluated as `agent` (D1).
- **Deny by default** for unknown actions and for evaluation errors (CEL runtime error, missing FGA answer becomes `authorization_unavailable`, as today).
- **Batching** is capped at 5 by Auth0's RAR limits and must show each item; it never applies to tier 1.

## 11. Success metrics

This is a reference implementation without production traffic. Metrics are measured in the test harness and the live demo.

| Type    | Metric                                                                     | Target                               |
| ------- | -------------------------------------------------------------------------- | ------------------------------------ |
| Leading | Parity test: decisions identical across MCP, REST and CLI                  | 100% of scenarios                    |
| Leading | Push or SMS notifications per approved operation, tiers 1 and 2            | 0                                    |
| Leading | MFA ceremonies for a reviewer approving 40 routine items in one session    | at most 2 (success), 1 (stretch)     |
| Leading | MFA ceremonies for 10 high-value items                                     | 2 with batching (5 per ceremony)     |
| Leading | Time from policy edit to enforcement                                       | under 60 s                           |
| Leading | Security suite: caller lowering a requirement, unknown action, budget race | all denied                           |
| Lagging | Approvals per 100 agent operations in the demo after budgets are enabled   | 50% fewer than threshold-only policy |
| Lagging | Injected bypass (unclaimed provider refund) detected                       | within one reconciliation cycle      |
| Lagging | Places a tenant must edit to change approval behaviour                     | 1 (from 5)                           |

## 12. Decisions

**D1. Actor type changes the outcome only through explicit rules.** Resolves Q2.

- Implicit behaviour ("agents are always stricter") makes policy impossible to read from the document, breaks simulation and surprises administrators. Every outcome must be explainable by the rules listed in its audit event.
- The safety concern (an administrator forgets to treat agents differently) is handled where it belongs: templates ship agent-specific rules, publish warns when an action has no rule distinguishing agents, and an unknown actor type is evaluated as `agent`.
- Agents are already constrained by their delegation (scope, resource, expiry), so equal outcomes for agents and humans are a choice, not a hole.

**D2. Budgets: reserve at registration, capture at claim, release on terminal non-execution.** Resolves Q5, and replaces the earlier claim-time-only proposal.

- Claim-time-only counting has two failures: an operation told `allow` at registration can find the budget gone at claim (a late surprise after the agent was told it was fine), and many concurrent registrations all see the same room.
- Registration-time-only counting starves the budget with abandoned operations for the full operation TTL (48 h by default).
- The hold-and-capture pattern (like a card authorization hold) fixes both: holds are atomic with registration, captured by the claim, released by any terminal outcome without a side effect, and expire after a short `budget_hold_ttl` so abandoned operations stop counting quickly.
- Unknown provider outcomes keep the hold until reconciled, so uncertainty never creates room.

## 13. Open questions

| #   | Question                                                                                                                                   | Owner       | Blocking  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | --------- |
| Q1  | Do we have the Highly Regulated Identity add-on on the demo tenant? Decides whether tier 2 uses PAR + RAR (P1-5) or service binding.       | Stakeholder | No (P1)   |
| Q2  | Should actor type change the outcome by default, or only when a rule says so? **Resolved: D1.**                                            | Stakeholder | Resolved  |
| Q3  | Default tier boundary for the refund template ($100 routine, $1,000 high value)?                                                           | Stakeholder | No        |
| Q4  | Does Auth0 FGA expose OpenFGA conditions (CEL with request context) on our plan? Needed for P2-2 only.                                     | Engineering | No        |
| Q5  | Should budgets count at registration or at claim? **Resolved: D2 (reserve at registration, capture at claim).**                            | Engineering | Resolved  |
| Q6  | Where does the operation-status URL live for multi-service customers: on the customer API or the service?                                  | Engineering | No        |
| Q7  | Retention of stored facts for simulation (privacy: facts can contain customer identifiers).                                                | Legal       | No (P1-1) |
| Q8  | Does the MCP client population we target handle RFC 9470-style step-up challenges, or do we render step-up as `approval_required` for MCP? | Engineering | No        |

## 14. Phasing

| Phase | Content                                                                                                       | Exit criteria                                         |
| ----- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 0     | P0-7, P0-8: WebAuthn-first Action, Action field fix, CIBA expiry and rejection attribution                    | Existing suites green; new CIBA attribution test      |
| 1     | P0-1, P0-5: `authority.protect`, `POST /v1/refunds`, CLI, operation status, human-direct mode                 | Parity suite green across MCP, REST, CLI              |
| 2     | P0-2, P0-3, P0-4: service-evaluated policy, versioned documents, budgets                                      | Security suite: caller cannot lower; budget race test |
| 3     | P0-6, P1-3, P1-4: queue, leases, tier 1 session assurance, batch decisions                                    | 40 routine approvals with 1 MFA ceremony in e2e test  |
| 4     | P1-1, P1-2, P1-7: simulation, shadow mode, templates                                                          | Simulation report on recorded demo operations         |
| 5     | P1-5, P1-6, P1-8 and P2 items as capacity allows: reviewer backend PAR + RAR, reconciliation, digest notifier | Injected bypass detected; live-tenant tier 2 verified |

Dependencies: Auth0 Enterprise features (HRI for PAR + RAR; Early Access for Agent as Principal and session metadata) gate P1-5, P2-4 and parts of tier 1. Every phase must keep `npm run lint`, `npm run build` and `npm test` green.

## Appendix: sources

- [Asynchronous Authorization (Auth0 for AI Agents)](https://auth0.com/ai/docs/intro/asynchronous-authorization)
- [Configure CIBA](https://auth0.com/docs/get-started/applications/configure-client-initiated-backchannel-authentication)
- [Email notifications with CIBA](https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow/email-notifications-with-ciba)
- [Configure Rich Authorization Requests](https://auth0.com/docs/get-started/apis/configure-rich-authorization-requests)
- [Authorization Code Flow with RAR](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow/authorization-code-flow-with-rar)
- [Authorization Code Flow with PAR](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow/authorization-code-flow-with-par)
- [Transactional Authorization with Authorization Code Flow](https://auth0.com/docs/secure/highly-regulated-identity/transactional-authorization-with-authorization-code-flow)
- [Post-login API object](https://auth0.com/docs/actions/reference/post-login/post-login-api-object) and [event object](https://auth0.com/docs/actions/reference/post-login/post-login-event-object)
- [Step-up authentication](https://auth0.com/docs/secure/multi-factor-authentication/step-up-authentication)
- [WebAuthn with device biometrics for MFA](https://auth0.com/docs/secure/multi-factor-authentication/fido-authentication-with-webauthn/configure-webauthn-device-biometrics-for-mfa)
- [Rate limit policy](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy)
- [MFA attack protection playbook](https://auth0.com/docs/secure/attack-protection/playbooks/mfa-playbook)
- [Configure session lifetime](https://auth0.com/docs/manage-users/sessions/configure-session-lifetime) and [session metadata](https://auth0.com/docs/manage-users/sessions/session-metadata)
- [Sender constraining (DPoP, mTLS)](https://auth0.com/docs/secure/sender-constraining)
- [Agent as Principal](https://auth0.com/docs/ai-agents-mcp/agent-as-principal)
- [Create an event stream](https://auth0.com/docs/customize/events/create-an-event-stream)
- RFC 9470, OAuth 2.0 Step Up Authentication Challenge Protocol
- RFC 9396, OAuth 2.0 Rich Authorization Requests
- RFC 9126, OAuth 2.0 Pushed Authorization Requests
- OpenID Connect CIBA Core 1.0
