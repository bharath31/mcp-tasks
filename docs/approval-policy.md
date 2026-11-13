# Approval policy implementation

Task Authority is this repo's custom approval backend, not a shipped Auth0 product. It runs inside Policy Desk's Worker by default or separately via Node. This page describes implemented behavior; [the PRD](prd-approval-policy.md) is historical rationale, not the current contract.

## Write your first policy

A policy is a versioned JSON document per API (resource server). Each action declares its typed arguments and who may approve; rules are [CEL](https://cel.dev) conditions over `args`, `actor`, `facts` and `relations`. Every matching rule applies and the strictest outcome wins (deny, then approval, then step-up, then allow); no match falls to `default`; actions the policy does not name are denied. The service evaluates only this document, never prose.

```json
{
  "resource_server": "https://api.northstar.example",
  "version": "refunds.v1",
  "unknown_action": "deny",
  "actions": {
    "refund:create": {
      "arguments": { "amountMinor": "int", "currency": "string" },
      "approvers": { "relation": "refund_approve", "on": "organization" },
      "rules": [
        {
          "id": "small",
          "when": "actor.type == \"agent\" && args.amountMinor <= 10000",
          "then": {
            "allow": {
              "budget": {
                "per": "principal",
                "window": "24h",
                "max_amount_minor": 50000,
                "max_count": 20
              }
            }
          }
        },
        {
          "id": "high-value",
          "when": "args.amountMinor > 100000",
          "then": { "approve": { "tier": "high_value", "quorum": 2 } }
        }
      ],
      "default": { "approve": { "tier": "routine" } }
    }
  },
  "tiers": {
    "routine": {
      "assurance": "session_mfa",
      "max_age": 3600,
      "dpop": "required"
    },
    "high_value": {
      "assurance": "per_operation",
      "factors": ["webauthn-platform", "webauthn-roaming"],
      "batch_max": 5
    }
  }
}
```

Read it as: an agent may refund up to $100 on its own, within $500 and 20 refunds a day; over $1,000 needs two reviewers each confirming this exact refund with a passkey; anything else needs one reviewer with a fresh MFA session on a DPoP-bound device.

Author and test it locally, with no server or token:

```sh
npm run --silent task-authority -- policy init refunds > refunds.json      # templates: refunds, production-deploys, data-exports
npm run task-authority -- policy check refunds.json               # schema, CEL type-check, tiers, budgets: what publishing enforces
npm run task-authority -- policy explain refunds.json refund:create --actor agent --args '{"amountMinor":150000,"currency":"usd"}'
# {"decision":"approval_required","reasonCode":"policy_approval_required","ruleIds":["high-value"],"tier":"high_value","quorum":2}
```

Publish it to a Task Authority service with a token that has `policies:write` (the admin M2M client), trying it in shadow mode and against recent traffic before it decides anything:

```sh
export TASK_AUTHORITY_URL='https://your-approval-backend.example'
# Set TASK_AUTHORITY_TOKEN privately to a policies:write token.
# Use the resource_server and version from YOUR file; these match the untouched template.
npm run task-authority -- policy apply refunds.json --shadow
npm run task-authority -- policy simulate https://api.northstar.example --version refunds.v1 --since 30d
npm run task-authority -- policy activate https://api.northstar.example refunds.v1
```

In the one-click deployment, each sandbox's policy is built by `sandboxPolicy()` in [`demo/policy-desk/src/policy.ts`](../demo/policy-desk/src/policy.ts) and published through the same `/v1/policies` API. The console's **Policy** view lets you change its four numeric limits and opt into authenticator-app codes for routine approvals, replay the change against your own operations, and publish and activate a new version; change that function and push to your copy to change the rules themselves.

The rest of this page is the full reference: administration, owner approval, budgets, reviewers, CIBA and provider reconciliation.

## Administration

Policy documents are JSON, keyed by tenant and resource-server identifier. The
service stores immutable versions and separate active and shadow pointers.
Use a service token with `policies:write` for publishing and activation; keep
these credentials separate from the refund application's credentials.

```sh
export TASK_AUTHORITY_URL=http://localhost:8788
# TASK_AUTHORITY_TOKEN is a policy administration access token.
npm run task-authority -- policy templates
npm run task-authority -- policy validate refunds.json
npm run task-authority -- policy apply refunds.json
npm run task-authority -- policy simulate https://api.northstar.example --version refunds.v1 --since 30d
npm run task-authority -- policy activate https://api.northstar.example refunds.v1 --shadow
npm run task-authority -- policy activate https://api.northstar.example refunds.v1
npm run task-authority -- policy list https://api.northstar.example
```

Templates cover refunds, production deploys, and data exports. Adapt the API
identifier, argument names, requester and approver relations before publishing; update the commands to match. Each changed document needs a new version. These CLI examples address the standalone backend; Policy Desk additionally resolves a sandbox tenant, so use its console/host API rather than assuming a bare admin M2M call selects a sandbox.
New registrations read the active pointer directly; activation requires no
restart. Existing operations retain their version, facts, actor and digest.
No configured policy means deny. `unknown_action: "approve"` requires an explicit
`unknown_action_approvers: { relation, on: "organization" }` and a routine tier;
`unknown_action_requester_relation` defaults to `member`. The operator's configured approval ceiling
and approver relation remain a floor.

### Policies are code, not prose

The service evaluates only the JSON document. Each rule's `when` is a CEL
expression (a typed subset: declared `args`, `actor`, `facts`, `relations`,
`aggregates`; no function calls) that is parsed, type-checked against the
action's declared arguments and compiled when the version is published, so a
typo fails `policy validate`, not a live request. Every matching rule applies
and the strictest outcome wins; no match falls to `default`.

Plain-English text, such as the rule list in the Policy Desk demo, is a reading
of that document for people and is never evaluated. Show it next to the CEL it
describes so the two cannot quietly disagree. Natural language can be a way to
draft a policy (a model proposes a document), but what gets published is the
document, after `validate`, `simulate` against recent traffic and a shadow
period. An ambiguous sentence must never be the thing that decides whether a
refund goes out.

### Who may register, and against which policy

A service caller needs the `operations:register` permission. A human token has
no service permissions, so a human calling the API directly must carry the same
name as an explicit grant in its signed `scope` or RBAC `permissions` claim;
the FGA requester relation still applies on top. Delegated registrations are
made by a trusted backend, which names the resource server from its own
configuration.

A human-direct registration (no delegation) chooses `resourceServer` itself, so
the operator decides which policies may govern it: the action needs an entry in
the operator floor (`TENANT_ACTIONS_JSON`), and that entry's `resourceServers`
must list the requested resource server. Otherwise the request is denied and
audited as `action_not_configured` or `resource_server_not_allowed`. An entry
without `resourceServers` permits no human-direct registration (fail closed).
Replays of an existing key are checked the same way. Only an operation that is
still `registered` can be completed by a caller step-up retry.

Conditions use a bounded CEL expression subset: scalar literals, field paths,
boolean operators, comparisons, arithmetic, lists and membership. Functions,
macros and loops are rejected. Publishing rejects undeclared arguments,
incompatible scalar types, undefined tiers and invalid durations. Every matched
rule contributes; deny takes precedence, then approval, step-up and allow.
Actor type influences a decision through explicit rules. Publishing warns about
actions with no explicit agent/human distinction.

## Owner approval

By default an approval needs a second person: the initiator, and the user who
delegated to the agent, can never approve it (`initiator_cannot_approve`). An
action can instead let that user approve their own agent's operation:

```json
"refund:create": { "self_approval": "owner", "approvers": { "relation": "refund_approve", "on": "organization" } }
```

The setting lives in the resource server's policy, so it applies to every
client that reaches the API: MCP, REST and CLI see the same approval for the
same operation. It applies only to user-owned delegations and single-approver
decisions; quorum and organization-owned agents keep separation of duties. The
owner must still hold the requester relation when deciding and when the claim
runs. An owner approval is always a fresh step-up bound to the approval id and
operation digest, never a review session, and needs a WebAuthn factor (`amr`
`webauthn-platform` or `webauthn-roaming`; the tier's WebAuthn factors if it
names any). OTP never satisfies it.

Each transport points at the same hosted approval page. REST returns 202 with
`reviewUrl`, the CLI prints it, and the SDK's default MCP rendering moves the task to `input_required` with
a URL-mode elicitation keyed `owner_approval:<approval id>` (`elicitationId` =
approval id). Each approval gets its own key, because MCP Tasks never lets a
server reuse an input-request key for a later request. The
elicitation answer only says whether the user went to the page; the agent
continues when Task Authority records the decision. `OperationView.ownerApproval`
and `ApprovalView.viewerRole` tell clients and the page which path applies. For headless hosts, `renderMcp(outcome, { ownerPrompt: "status" })` keeps the task `working` and puts the link in its status instead. Policy Desk does not use owner elicitation; its visitor reviews requests delegated by Alex.

## Budget holds

Budgeted allow rules reserve amount/count during registration in the same
transaction as the operation. Reservations serialize by budget scope across
service processes. Claims capture the reservations. Cancellation, rejection,
expiry and `not_submitted` release them. Unknown provider outcomes retain their
reservation until reconciled. `budget_hold_ttl` defaults to `15m`.

A claim after its hold expires checks available budget again. When it no longer
fits, the service re-evaluates the pinned policy without the exhausted rule and
refuses that claim with `budget_exhausted`. The caller can inspect the operation
and request the newly required approval. Changing the active policy does not
rewrite this operation.

## Application and reviewer paths

The SDK's `authority.protect` registers facts, renders the policy outcome and
requires an atomic claim before a mutation. The refund demo's MCP tool, REST
`POST /v1/refunds`, and CLI all use this path. `202` responses expose an operation
URL and reviewer link. CLI `--wait` polls that URL. See
[the demo README](../demo/refund-desk/README.md) for configuration and examples.

Reviewers use an FGA-filtered queue and short leases. Losing the approver
relation removes list, lease and decision access. A human initiator cannot
approve their own request. Routine policies accept a verified DPoP proof and a
fresh MFA session with idle and velocity limits. High value policies require a
fresh operation binding. Decisions record the policy snapshot and exact digest.

With `REVIEWER_PAR_ENABLED=1`, the demo's confidential reviewer backend pushes
RAR through Auth0 PAR, uses PKCE, retains tokens on the server, and confirms at
most five compatible items. Without HRI, the browser obtains a service-issued
challenge bound to reviewer, digest and DPoP key, and performs WebAuthn-first
step-up. Auth0 Actions must be deployed with the configured audience and claim
namespace. CIBA is initiated by the explicit escalation endpoint and is never
the default review path. A CIBA denial records a hint rather than a verified
approver identity.

## Provider events and digest integration

`POST /v1/provider-events` accepts a refund event from a trusted backend with
`provider-events:write`. The backend verifies its provider webhook signature
before calling Task Authority. Claim IDs travel in provider metadata. A matching
claim must have the same tenant, organization, action and resource. A refund
event using claim metadata also matches the canonical amount and currency. One
claim covers only one provider reference. Unmatched
events append `bypass.detected`; duplicate provider references do not duplicate
audit events. `createHandler({alertHook})` exposes an optional delivery callback.
The refund demo includes a Stripe signature-verifying webhook adapter.

`POST /v1/approval-requests/digest` returns a coalesced, eligibility-filtered
reviewer digest with count, oldest age and a queue link. It emits at most one
ready payload per reviewer per fifteen minutes. Delivery is an integration;
the payload carries no approval authority.

## Verification and limits

The deterministic harness uses local Postgres, a signing test identity provider,
and an in-memory FGA implementation (or `OPENFGA_BIN` for real OpenFGA). It covers
policy validation, immutable versions, raise-only assertions, concurrent budget
holds, hold release/recheck, human separation of duties, queue leases, DPoP
proofs, reviewer sessions, batch atomicity, transport parity and reconciliation.
Run `npm run lint`, `npm run build`, and `npm test`.

PAR/RAR and CIBA still require live-tenant verification; Policy Desk's separate service-challenge/WebAuthn path has manual demo-tenant evidence, not CI coverage of real authenticators. The reference confidential reviewer backend keeps pending
OAuth transactions in memory for five minutes; restarting it requires a new
login. Policy Desk has a limited policy console (four numeric settings, the routine TOTP opt-in and simulation). A general policy editor, Terraform provider, identity Event Streams revocation, conditional approver limits and role-diverse quorum remain future work. This implementation makes no production SLA or multi-region guarantees.
