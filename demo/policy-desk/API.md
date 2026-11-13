# Policy Desk sandbox API (contract for the browser UI)

This is the host API for Policy Desk's default `APPROVAL_MODE=authority`. The approval backend is custom repository code running in the same Worker, not an Auth0 product. Examples show relevant fields, not exhaustive schemas; see [`src/api.ts`](src/api.ts), [`src/mcp.ts`](src/mcp.ts) and the [backend OpenAPI contract](../../auth0/service/openapi.json).

Same origin as the UI. **Identity uses Auth0 in deployment** (local tests use fixtures): there is no `/sandbox/session`
and the Worker never issues tokens. The SPA signs the visitor in with Universal
Login (Authorization Code + PKCE, `audience` = the Task Authority API audience,
`organization` = the demo organization, DPoP on) and sends that **access token**
as `Authorization: Bearer <token>` (or `DPoP <token>` plus a `DPoP` proof header
on DPoP-bound calls). Payments are the labelled simulator only.

One real user owns exactly one sandbox (`sbx_<24 hex>`, derived from the token
`sub`). Data lives under a per-generation tenant, so visitors cannot see each other.

## Refusals are machine-readable

Host guardrail refusals on `/sandbox/*` and `/v1/refunds*` use the following shape (optional fields depend on the failure). Forwarded backend errors and MCP JSON-RPC errors have separate contracts:

```json
{
  "error": "policy_value_out_of_range",
  "reason": "policy_value_out_of_range",
  "message": "agentAutoLimitMinor must be a whole number between 1000 and 50000.",
  "hint": "Amounts are in cents.",
  "nextAction": "fix_policy_values"
}
```

`reason` is stable (use it for logic), `message` and `hint` are plain language,
`nextAction` can be null or a UI hint such as `sign_in`, `reset_sandbox`, `retry_later`, `fix_policy_values`,
`pick_order`, `pick_scenario`, `pick_operation`, `change_amount`, `open_review_queue`,
`use_other_reviewer`, `contact_operator`, `none`. `retryAfterSec` is included for applicable retryable guardrails; it is not required on every 429/503. The policy-validation example above therefore omits it.
Responses coming straight from the Task Authority service (`/v1/*` other than
`/v1/refunds*`) keep the service shape `{code,message,details:{reason},...}`.

| Reason (`reason`)                                                                                                                                                                                                        | Status                          | When                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_identity`                                                                                                                                                                                                       | 401                             | missing/invalid Auth0 token                                                                                                        |
| `organization_required`, `wrong_organization`                                                                                                                                                                            | 403                             | no `org_id`, or not the demo organization                                                                                          |
| `sandbox_not_initialized`                                                                                                                                                                                                | 404                             | call `POST /sandbox/reset` first                                                                                                   |
| `sandbox_expired`                                                                                                                                                                                                        | 410                             | older than 15 minutes; `POST /sandbox/reset` revives it for another 15 minutes                                                     |
| `sandbox_capacity`                                                                                                                                                                                                       | 503                             | global cap of active sandboxes                                                                                                     |
| `rate_limited`                                                                                                                                                                                                           | 429                             | per-IP or per-user window exceeded                                                                                                 |
| `policy_value_out_of_range`, `policy_thresholds_inverted`, `policy_edit_not_allowed`                                                                                                                                     | 422                             | policy edit outside the safe envelope                                                                                              |
| `policy_publish_limit`                                                                                                                                                                                                   | 429                             | more than 10 policy versions per hour                                                                                              |
| `quota_exceeded`                                                                                                                                                                                                         | 429                             | more than 10 pending approvals (enforced by the service)                                                                           |
| `sandbox_operation_limit`                                                                                                                                                                                                | 429                             | more than 50 operations in this sandbox generation                                                                                 |
| `wrong_sandbox`                                                                                                                                                                                                          | 403                             | an agent key used with another sandbox's id                                                                                        |
| `delegation_expired`                                                                                                                                                                                                     | 409                             | the agent's delegation (from Alex) expired; `POST /sandbox/scenario` and `/sandbox/reset` re-grant it, `nextAction: reset_sandbox` |
| `order_not_found`, `refund_not_eligible`, `invalid_request`, `unknown_scenario`                                                                                                                                          | 404/409/400/404                 | bad input                                                                                                                          |
| `not_configured`, `dependency_unavailable`                                                                                                                                                                               | 503                             | deployment problem                                                                                                                 |
| Service reasons surfaced under `reasonCode`/`error.details.reason`, e.g. `mfa_required`, `dpop_required`, `factor_not_satisfied`, `initiator_cannot_approve`, `not_org_approver`, `approval_pending`, `budget_exhausted` | 401/403/409 as the service says | the real policy / assurance checks                                                                                                 |

## Endpoints

| Path                                            | Auth                            | Purpose                                                                                     |
| ----------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /sandbox/info`                             | none (optional token)           | banner, Auth0 config for the SPA, roles, scenarios, policy, envelope, limits                |
| `GET /sandbox/me`                               | Auth0 token                     | who you are, token assurance snapshot, whether your sandbox exists                          |
| `POST /sandbox/reset`                           | Auth0 token                     | create or recreate your sandbox: FGA tuples, policy, delegation, orders                     |
| `GET /sandbox/agent-key`                        | Auth0 token                     | whether your own agent holds a key: `{available, connected, mcpUrl, expiresAt, lastUsedAt}` |
| `POST /sandbox/agent-key`                       | Auth0 token                     | 201: a new agent key for this sandbox (replaces any earlier one), see below                 |
| `DELETE /sandbox/agent-key`                     | Auth0 token                     | revoke your agent's key                                                                     |
| `POST /mcp`                                     | Auth0 token / sandbox agent key | MCP Tasks JSON-RPC endpoint (see below)                                                     |
| `GET /sandbox/admin/usage?days=14`              | Operator identity               | Usage metrics; allow-listed verified email or subject required                              |
| `GET /.well-known/oauth-protected-resource/mcp` | none                            | OAuth discovery metadata for MCP hosts                                                      |
| `POST /sandbox/agent`                           | Auth0 token                     | `{message}`: one turn of the refund agent; the server adds it to the stored conversation    |
| `GET /sandbox/agent/conversation`               | Auth0 token                     | the stored agent conversation of this sandbox generation (survives reloads and tabs)        |
| `DELETE /sandbox/agent/conversation`            | Auth0 token                     | start a new agent conversation                                                              |
| `POST /sandbox/scenario`                        | Auth0 token                     | run a canned request through the real `POST /v1/refunds`                                    |
| `GET /sandbox/state`                            | Auth0 token                     | orders, operations, budget, progress, policy settings                                       |
| `GET /sandbox/progress`                         | Auth0 token                     | guided-tour booleans derived from real state                                                |
| `GET /sandbox/audit?operationId=`               | Auth0 token                     | audit events of one operation                                                               |
| `GET /sandbox/orders`                           | Auth0 token                     | sample orders                                                                               |
| `GET /sandbox/policy`                           | Auth0 token                     | active settings, summary, envelope                                                          |
| `PUT /sandbox/policy`                           | Auth0 token                     | edit a few numbers inside the safe envelope; publishes + activates a new version            |
| `POST /sandbox/restore-policy`                  | Auth0 token                     | publish + activate the default template again (new version)                                 |
| `POST /sandbox/simulate`                        | Auth0 token                     | what-if of the agent auto-approve limit against this sandbox's operations                   |
| `POST /v1/refunds`                              | Auth0 token                     | customer REST path: 201 executed, 202 approval, 401 step-up, 403 deny                       |
| `GET /v1/refunds/{op}`                          | Auth0 token                     | operation + order + refund                                                                  |
| `POST /v1/refunds/{op}/run`                     | Auth0 token                     | resume an approved operation (claim + simulated refund)                                     |
| `/v1/*` (everything else)                       | Auth0 token                     | the real Task Authority service, scoped to your sandbox tenant                              |

`/mcp`, `POST /v1/refunds` and `GET`/`POST /v1/refunds/{op}*` also accept an **agent key**
(`Authorization: Bearer <key>`), with no sandbox header: the key names its sandbox.

## POST /sandbox/agent-key

Body `{}`. Mints a fresh Auth0 client-credentials token for the external agent client and
binds its SHA-256 to your sandbox. The token is returned once and never stored.

```json
{
  "token": "eyJ…",
  "tokenType": "Bearer",
  "expiresAt": "2026-10-25T12:00:00.000Z",
  "mcpUrl": "https://<host>/mcp",
  "claudeCode": "claude mcp add --transport http policy-desk https://<host>/mcp --header \"Authorization: Bearer eyJ…\"",
  "mcpJson": {
    "mcpServers": {
      "policy-desk": {
        "type": "http",
        "url": "https://<host>/mcp",
        "headers": { "Authorization": "Bearer eyJ…" }
      }
    }
  },
  "note": "…"
}
```

Refusals: 429 `rate_limited` (5 per visitor per hour), 503 `not_configured` (no
`EXTERNAL_AGENT_CLIENT_ID`). With the key: 401 `invalid_identity` once it was replaced,
revoked or expired; 403 `wrong_sandbox` if the request names another sandbox; 410
`sandbox_expired` while the expired sandbox still exists. A reset can revive that binding only before cleanup deletes it; after cleanup, issue a new key.

With `Accept: application/x-ndjson`, `POST /sandbox/agent` streams one JSON object per line while the turn runs:
`model_start`, `model_done` (with its `ms`), `tool_start`, `tool_done` (the MCP exchanges and `ms`), then `done` with the
same body as the JSON response plus `timings` (Postgres connect and round trips, FGA calls, model calls), or `error`
with `status` and the usual refusal body. Every other dynamic response carries a `Server-Timing` header with the same
split.

Reviewing uses the real service directly: `GET /v1/approval-requests?status=pending`
(FGA-filtered, your own requests are hidden), `POST /v1/approval-requests/{id}/lease`,
`POST /v1/approval-requests/{id}/decisions` with `{decision, operationDigest}`. What
the token must prove is pinned in the operation's policy snapshot. Unlike the generic refund template, **both routine and high-value sandbox approvals are per-operation**. They require fresh WebAuthn evidence bound through `POST /v1/approval-requests/{id}/challenge`; `allowAuthenticatorApp=true` also permits fresh TOTP for routine requests only. The SPA uses the repository's Auth0 Actions to get challenge/assurance claims, then submits the DPoP-bound decision token. Rejection by an eligible DPoP-bound reviewer needs no second factor. See [step-up flows](../../docs/approval-step-up-flows.md).

## GET /sandbox/info

```json
{
  "banner": "PUBLIC SANDBOX: real Auth0 login, MFA and approvals; simulated payments only. Your sandbox is deleted after 15 minutes.",
  "paymentsMode": "simulator",
  "auth": {
    "domain": "tenant.us.auth0.com",
    "audience": "https://policy-desk.example/task-authority",
    "appAudience": "https://policy-desk.example/task-authority",
    "spaClientId": "…",
    "organization": "org_…"
  },
  "roles": [
    {
      "id": "agent",
      "name": "Refund agent",
      "description": "…",
      "canApprove": false
    },
    { "id": "you", "name": "You", "description": "…", "canApprove": true }
  ],
  "scenarios": [
    {
      "id": "routine_approval",
      "title": "$150 needs routine approval",
      "description": "…",
      "as": "agent",
      "expect": { "status": 202, "decision": "approval_required" }
    }
  ],
  "policy": {
    "resourceServer": "https://policy-desk.task-authority.demo/refunds",
    "version": "refunds.v1",
    "settings": {
      "agentAutoLimitMinor": 10000,
      "budgetMaxMinor": 50000,
      "budgetMaxCount": 20,
      "highValueAboveMinor": 100000,
      "allowAuthenticatorApp": false
    },
    "summary": [{ "id": "small", "tier": "auto", "text": "…" }],
    "envelope": {
      "agentAutoLimitMinor": [1000, 50000],
      "budgetMaxMinor": [1000, 200000],
      "budgetMaxCount": [1, 50],
      "highValueAboveMinor": [20000, 500000]
    },
    "defaults": {}
  },
  "limits": {
    "sandboxTtlMinutes": 15,
    "maxPendingApprovals": 10,
    "maxOperations": 50,
    "maxPolicyPublishesPerHour": 10
  },
  "endpoints": ["GET /sandbox/info", "…"],
  "sandbox": null
}
```

Scenario ids: `small_within_budget` (201), `routine_approval` (202), `high_value` (202),
`budget_exhausted` (202 after several 201), `unknown_action` (403), `assert_none`
(202, caller cannot lower the requirement), `self_approval` (202; your own request
is hidden from your queue), `human_step_up` (401 challenge unless your token already
has MFA newer than 5 minutes, then 201). `as` is `agent` (a real Auth0 M2M client driven
by the Worker) or `you` (your own token is used).

## GET /sandbox/me

```json
{
  "sub": "auth0|…",
  "orgId": "org_…",
  "initialized": false,
  "sandboxId": "sbx_74876a6c66be4bab30c515eb",
  "sandbox": null,
  "token": {
    "amr": ["pwd"],
    "acr": null,
    "authTime": 1792058874,
    "expiresAt": "2026-10-15T11:07:54.000Z",
    "dpopBound": false
  }
}
```

## POST /sandbox/reset

Body `{}` or `{ "allowAuthenticatorApp": true }`. Creates the sandbox on first use. **Each call creates a new generation**, so do not automatically retry it as an idempotent operation. Reset restores numeric policy defaults and an empty budget, preserving the prior authenticator-app setting unless the body overrides it. Superseded generations are eligible for cleanup after five minutes; cleanup runs every five minutes. Needs Auth0, FGA and Postgres.

```json
{
  "sandboxId": "sbx_…",
  "generation": 1,
  "policyVersion": "refunds.v1",
  "delegationId": "dlg_…",
  "orders": [
    {
      "orderId": "ord_…",
      "customer": "Dana Whitfield",
      "item": "Trail jacket",
      "amountMinor": 24000,
      "refundedMinor": 0,
      "currency": "USD"
    }
  ],
  "sandbox": {
    "id": "sbx_…",
    "orgId": "…",
    "generation": 1,
    "createdAt": "…",
    "expiresAt": "…",
    "policyVersion": "refunds.v1",
    "delegationId": "dlg_…",
    "settings": {}
  }
}
```

## POST /sandbox/scenario

Body `{ "id": "routine_approval" }`.

```json
{
  "scenario": {
    "id": "routine_approval",
    "title": "$150 needs routine approval"
  },
  "request": {
    "method": "POST",
    "path": "/v1/refunds",
    "as": "agent",
    "body": {
      "orderId": "ord_…",
      "amountMinor": 15000,
      "currency": "USD",
      "reason": "Wrong size returned"
    }
  },
  "response": {
    "status": 202,
    "headers": {
      "location": "/v1/operations/op_…",
      "content-type": "application/json"
    },
    "body": {
      "decision": "approval_required",
      "reasonCode": "policy_approval_required",
      "policyVersion": "refunds.v1",
      "ruleIds": ["default"],
      "executed": false,
      "operation": {},
      "operationUrl": "/v1/operations/op_…",
      "reviewUrl": "/review?approval=apr_…&sandbox=sbx_…"
    }
  },
  "decision": "approval_required",
  "reasonCode": "policy_approval_required",
  "operationId": "op_…",
  "approvalId": "apr_…",
  "cli": { "exitCode": 0, "output": "{…}", "waitUrl": "/v1/operations/op_…" },
  "mcp": {
    "status": "working",
    "statusMessage": "Waiting for approval: /review?…",
    "authority": {
      "decision": "approval_required",
      "reasonCode": "…",
      "policyVersion": "…",
      "ruleIds": []
    }
  },
  "steps": [],
  "explain": null,
  "expect": { "status": 202, "decision": "approval_required" }
}
```

`response.headers` always includes `location` (202), `www-authenticate` (401),
`content-type`, `retry-after` when present. `cli`/`mcp` come from the SDK's
`renderCli`/`renderMcp` of the same outcome (null when the response is an error).
`steps` is non-empty for multi-request scenarios; each step is
`{ request:{as,body}, status, decision, reasonCode, headers? }`. `explain` is
`{reason:"budget_exhausted", message}` for the budget scenario. Step-up (401) bodies
carry `operation.stepUp = {acr, max_age}`; the SPA re-authenticates with those
values and runs the scenario again.

## GET /sandbox/state

`{ sandboxId, generation, orders[], operations[], budget, progress, policy }`.

```json
{
  "operations": [
    {
      "id": "op_…",
      "action": "refund:create",
      "amountMinor": 15000,
      "orderId": "ord_…",
      "customer": "Scenario Customer",
      "reason": "Wrong size returned",
      "actor": { "type": "agent", "id": "auth0|<Alex sub>" },
      "initiator": "auth0|<Alex sub>",
      "decision": "approval_required",
      "reasonCode": "policy_approval_required",
      "ruleIds": ["default"],
      "policyVersion": "refunds.v1",
      "tier": "routine",
      "outcomeStatus": "pending_approval",
      "approval": {
        "id": "apr_…",
        "status": "pending",
        "quorum": 1,
        "approvals": 0
      },
      "digest": "sha256:…",
      "createdAt": "…"
    }
  ],
  "budget": {
    "usedMinor": 0,
    "maxMinor": 50000,
    "usedCount": 0,
    "maxCount": 20
  },
  "progress": {}
}
```

`outcomeStatus` is derived like the service's (`pending_approval`, `approved`,
`rejected`, `completed`, `failed`, `denied`); treat unknown values as opaque.

## GET /sandbox/progress

Derived from real service state, never from client clicks:

```json
{
  "sandboxId": "sbx_…",
  "progress": {
    "signedIn": true,
    "policyPublished": true,
    "autoAllowedRefund": false,
    "approvalRequestedRefund": true,
    "approvedWithStepUp": false,
    "eventsPresent": true,
    "policyEdited": false
  }
}
```

`approvedWithStepUp` = an approval decision with `mfa` in its recorded assurance.
`policyEdited` = a version published through `PUT /sandbox/policy`.

## GET /sandbox/audit?operationId=op\_…

```json
{
  "events": [
    {
      "id": "3",
      "type": "operation.registered",
      "decision": "allow",
      "reasonCode": "policy_approval_required",
      "actor": { "kind": "service", "id": "…" },
      "createdAt": "…",
      "ruleIds": ["default"],
      "policyVersion": "refunds.v1",
      "act": null,
      "policyActor": { "type": "agent", "id": "auth0|<Alex sub>" },
      "evaluation": {}
    }
  ]
}
```

`policyActor` is the actor chain the service recorded (delegating user, type
`agent`); `act` is the OAuth `act` claim when the token carried one.

## PUT /sandbox/policy and POST /sandbox/restore-policy

`PUT` body: any of `agentAutoLimitMinor` (1000-50000), `budgetMaxMinor` (1000-200000),
`budgetMaxCount` (1-50), `highValueAboveMinor` (20000-500000, must exceed the agent
limit), plus optional boolean `allowAuthenticatorApp`. This adds TOTP to routine per-operation approvals only; high value remains WebAuthn. Anything else (approvers, `unknown_action`, arbitrary tier definitions) is refused with
`policy_edit_not_allowed`. The Worker builds the document, so the approver floor and
`unknown_action: deny` cannot be removed. Response:
`{ "version": "refunds.edit-…", "policy": { version, settings, summary, envelope, … } }`.
Both are published and activated through the real `/v1/policies` API; existing
operations keep the version they were registered under.

## POST /sandbox/simulate

Body `{ "thresholdMinor": 20000 }` (same range as `agentAutoLimitMinor`). Runs the
service's real policy simulation over this sandbox's last 24 hours without activating.

```json
{
  "considered": 4,
  "changed": 1,
  "rows": [
    {
      "operationId": "op_…",
      "summary": "$150.00 for Scenario Customer by agent",
      "before": "approval_required",
      "after": "allow"
    }
  ],
  "candidate": {
    "version": "whatif-20000",
    "agentAutoApproveLimitMinor": 20000
  },
  "counts": {}
}
```

## POST /v1/refunds

Body `{ orderId, amountMinor, currency?: "USD", reason?, action?: "refund:create", approvalAssertion?: "none" | "human" }`.
`Idempotency-Key` makes retries safe. Status 201 / 202 / 401 (`WWW-Authenticate:
Bearer error="insufficient_user_authentication", acr_values="mfa", max_age="300"`) /
403 / 429; the body is the SDK outcome (`decision`, `reasonCode`, `policyVersion`,
`ruleIds`, `executed`, `operation`, `operationUrl`, `reviewUrl`, `result`). A refused
call adds `reason`, `message`, `hint`, `nextAction` where the host maps the refusal.

## POST /mcp

Policy Desk implements MCP `2026-07-28` with per-request metadata, **not** an `initialize` handshake. Supported methods are `server/discover`, `tools/list`, `tools/call`, `tasks/get`, `tasks/update` and `tasks/cancel`. There are no subscriptions, `tasks/list` or `tasks/result`.

A request to create a refund task has this shape (replace the order id with one from `list_orders`):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "request_refund",
    "arguments": {
      "orderId": "ord_example",
      "amountMinor": 15000,
      "reason": "Customer returned the item"
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": { "io.modelcontextprotocol/tasks": {} }
      }
    }
  }
}
```

- Authenticate with a sandbox agent key or a supported Auth0 token. `server/discover` itself is public. Host OAuth uses the `/mcp` resource audience; console and agent-key audiences are described in the [README](README.md#signing-in-from-an-mcp-host-claude-code).
- `request_refund` and `tasks/*` require the Tasks capability on each request; missing capability yields `-32021`. An unsupported version or `initialize` yields `-32022`.
- Read-only tools are `list_orders` and `get_order`. A refund with a registered operation returns `resultType: "task"`; business validation can instead return a complete tool error before any operation exists.
- Poll `tasks/get` with `params.taskId`, the same protocol/capability metadata, and the caller's credential. If supplied, `Mcp-Name` must match that task id. Default polling interval is 3 seconds.
- `tasks/get` may **execute** a now-authorized refund through the claim path; it is not a read-only HTTP operation. `POST /v1/refunds/{id}/run` also resumes it. Approval alone does not schedule a background worker.
- Waiting tasks stay `working` with a review URL. `tasks/update` acknowledges and ignores input responses because Policy Desk never requests client input. `tasks/cancel` withdraws unclaimed work; it cannot reverse a dispatched refund.
- The wire task TTL is 24 hours, but sandbox expiry after 15 minutes and later cleanup limit availability sooner. Do not treat that TTL as a retention guarantee.

The experimental `APPROVAL_MODE=approve` uses a separate proof ledger rather than Task Authority policy decisions; the authority-mode examples above do not describe that mode's policy or outcome contract.
