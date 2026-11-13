# `@task-authority/sdk` (prototype SDK)

Local, unpublished package for **this repo's custom approval backend**, internally called Task Authority. The backend is embedded in Policy Desk's Worker or run separately with its Node adapter. Neither the backend nor this package is an official Auth0 product or SDK. Use it in a trusted backend with service credentials. Browser reviewers use OAuth and the service HTTP API directly.

## Quick start

```ts
import { createTaskAuthority } from "@task-authority/sdk";

const authority = createTaskAuthority(); // task-authority.json + TASK_AUTHORITY_* env

type Refund = { paymentId: string; amountMinor: number; currency: string };
export const refund = authority.action("refund:create", {
  resource: (r: Refund) => `payment:${r.paymentId}`,
  facts: async (r) => ({
    refundableMinor: await refundableBalance(r.paymentId),
  }),
  run: (r, { key }) =>
    stripe.refunds.create(
      { payment_intent: r.paymentId, amount: r.amountMinor },
      { idempotencyKey: key },
    ),
});

const outcome = await refund(
  { paymentId, amountMinor: 1500, currency: "usd" },
  { user: token, key: requestId }, // stable across retries of this logical refund
);
return outcome.toResponse();
```

This is an integration sketch: `stripe`, `refundableBalance`, `paymentId`, `token` and `requestId` come from your application. `token` must be for the approval backend's audience; configure the organization and policy namespace before calling.

`authority.action(name, definition)` declares a protected mutation once; every transport calls the returned function. It is a thin layer over `protect` below, with the same guarantees.

### Configuration

`createTaskAuthority(config?)` merges, highest first: the object you pass, environment variables, then a JSON file (`TASK_AUTHORITY_CONFIG`, else `./task-authority.json` if present). Keep secrets in the environment.

| Setting                                    | Environment                                                                  | Meaning                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `url`                                      | `TASK_AUTHORITY_URL`                                                         | Task Authority base URL (required)                                                                     |
| `resourceServer`                           | `TASK_AUTHORITY_RESOURCE_SERVER`                                             | Policy namespace shared by REST, MCP and CLI                                                           |
| `organizationId`                           | `TASK_AUTHORITY_ORGANIZATION`                                                | Default organization of callers                                                                        |
| `reviewUrl`                                | `TASK_AUTHORITY_REVIEW_URL`                                                  | Reviewer link; `{approvalId}` is substituted                                                           |
| `domain`                                   | `AUTH0_DOMAIN`                                                               | Auth0 tenant for client credentials                                                                    |
| `audience`                                 | `TASK_AUTHORITY_AUDIENCE`                                                    | Task Authority API audience                                                                            |
| `api`                                      | `TASK_AUTHORITY_CLIENT_ID`, `TASK_AUTHORITY_CLIENT_SECRET`                   | M2M client that registers operations                                                                   |
| `executor`                                 | `TASK_AUTHORITY_EXECUTOR_CLIENT_ID`, `TASK_AUTHORITY_EXECUTOR_CLIENT_SECRET` | M2M client that claims before the side effect; defaults to `api`                                       |
| `getAccessToken`, `getExecutorAccessToken` | code only                                                                    | Token sources that replace client credentials                                                          |
| `env`                                      | code only                                                                    | Environment to read instead of `process.env`, e.g. a Worker's `env`; then no file is read unless named |

Tokens are fetched with the client-credentials grant and cached until 30 seconds before expiry. A missing setting fails with a message naming the variable.

### Definition and call

| Definition  | Meaning                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `resource`  | The exact resource the operation touches. The input itself becomes the operation's canonical `arguments`. |
| `run`       | The side effect, called with `(input, { claim, operation, key })` only after an authorized claim          |
| `facts`     | Optional business facts the policy reads; derive them from trusted data                                   |
| `version`   | Optional business-state version bound into the digest                                                     |
| `reconcile` | Optional read-only provider lookup after an uncertain claim; return `null` when nothing was submitted     |
| `reference` | Provider reference for the outcome report; default `result.id`                                            |

Call options: `user` (the caller's verified access token, or a `VerifiedSubject`), `delegation` (agents acting for an owner), `org`, `key` (stable idempotency key for one logical side effect; default a fresh id per call, so pass one when callers retry), `facts`, `version`, `taskId`, `approvalAssertion`, `prepareOnly`.

Outcome reporting is automatic: a resolved `run` reports `succeeded`, a `null` from `reconcile` reports `not_submitted`, and a thrown error reports `unknown` (so the operation is reconciled, never blindly retried) before rethrowing. If your callback calls `claim.report` itself, nothing more is reported.

The outcome is `protect`'s outcome plus `toResponse()`, `toMcp()` and `toCli()` (the renderers below). `action.resume(operationId, input)` continues a registered operation, for example after approval; pass the input from your own durable record of the request. Its action, resource and canonical arguments must match the operation; otherwise it throws `resume_input_mismatch`.

`createTaskAuthority` returns a `TaskAuthority`, so `delegations`, `operations`, `approvals`, `audit` and `protect` are on the same object, and the executor client is `authority.executor`. `demo/policy-desk/src/refunds.ts` uses this API.

## No service: `approve()` (experimental)

`@task-authority/sdk/approve` makes a human decision one step of a durable workflow without the Task Authority service. The engine holds the wait; the proof is a token Auth0 signs (a fresh passkey sign-in, or a CIBA push), verified inside the workflow against the tenant's keys and bound to the exact action, arguments, run and step.

```ts
import { approve } from "@task-authority/sdk/approve/cloudflare";

const ok = await approve(step, event, env, {
  action: "refund:create",
  resource: `payment:${paymentId}`,
  args: { paymentId, amountMinor: 15000, currency: "USD" },
  approvers: { roles: ["finance"] },
  requester: requesterSubject, // verified by your app; enables the self-approval check
  notify: (link) => sendEmail(financeTeam, link),
});
await stripe.refunds.create(
  { payment_intent: paymentId, amount: 15000 },
  { idempotencyKey: ok.key },
);
```

Other engines build on the same exports: `createApprovalRequest`, `approvalLink`, `handleApprovalRoute`, `verifyApproval`, `startPush` and `pollPush`. How it works, what it guarantees and what is verified so far: [docs/approve.md](../../docs/approve.md).

## Full control: `protect`

Every transport calls the same protected application function. Task Authority evaluates its versioned policy from the canonical arguments, business facts and verified actor. The SDK invokes the mutation only after `authorizeAndClaim` succeeds.

```ts
import {
  TaskAuthority,
  verifiedSubject,
  renderRest,
} from "@task-authority/sdk";

const authority = new TaskAuthority({
  baseUrl: process.env.TASK_AUTHORITY_URL!,
  getAccessToken: () => apiMachineToken(),
});
const executor = new TaskAuthority({
  baseUrl: process.env.TASK_AUTHORITY_URL!,
  getAccessToken: () => executorMachineToken(),
});

// The resource server verifies this token before reaching the application function.
// Task Authority verifies the forwarded token again; a bare subject id is insufficient.
const initiator = verifiedSubject({
  accessToken: userTokenForAuthorityAudience,
  organizationId,
});

const outcome = await authority.protect(
  "refund:create",
  async () => ({
    resourceServer: "https://refunds.example/api", // one policy namespace for every transport
    organizationId,
    operationKey,
    delegationId, // omit for a verified human calling directly
    initiator,
    resource: `payment:${paymentId}`,
    arguments: { amountMinor, currency, paymentId },
    facts: { refundableMinor: await refundableBalance(paymentId), reason },
    businessStateVersion: paymentVersion,
  }),
  async (claim) => {
    // This callback receives an authorized claim, never reconcile_required.
    const refund = await provider.refund({
      paymentId,
      amountMinor,
      idempotencyKey: operationKey,
      metadata: { authority_claim_id: claim.claimId },
    });
    await claim.report(refund.status, refund.id);
    return refund;
  },
  {
    executor,
    reviewUrl: (approvalId) =>
      `https://refunds.example/review?approval=${approvalId}`,
  },
);

return renderRest(outcome);
```

Publish and activate a policy for `resourceServer` before registering operations. Missing policies, unknown actions and evaluation errors deny by default. `approvalAssertion` is optional and **omitted by default**. If supplied, `"human"` can raise the requirement; `"none"` cannot lower a service rule or operator floor. `facts` are recorded assertions from the resource server, so derive them from trusted business data.

A human may register without `delegationId`, with a verified `initiator`, `organizationId` and `resourceServer`. Agent operations use a delegation. Actor classification comes from verified authentication and the delegation model, never a tool argument. The service enforces separation of duties even for human-direct operations.

For agent delegations, `delegations.create` takes an `owner: verifiedSubject(...)` and `agent: verifiedAgent(...)`, plus `ownerType`, `resource`, `actions` and `expiresAt`; optional `resourcePrefixes`, numeric `ceilings`, `reason` and `idempotencyKey` further constrain it. These helper types carry verified context; they do not verify tokens locally.

## Outcomes and renderers

`protect(action, factsFn, execute, options?)` returns:

- `decision`: `allow`, `approval_required`, `step_up_required` or `deny`.
- `reasonCode`, immutable `policyVersion`, matched `ruleIds`, and the `operation` snapshot.
- `operationUrl`, optional `reviewUrl`, `executed`, optional callback `result` and `claim`.

The guard registers the operation, requests review when required and stops before executing for approvals, caller step-up or denial. An approval is a server-side record bound to the digest; clients carry no approval grant. Claim-time checks can still refuse an operation after registration allowed it.

| Renderer                     | Behavior                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `renderRest(outcome)`        | Web `Response`: executed `201`; pending work/approval `202` with `Location`; denial `403`; caller step-up `401` with RFC 9470 `WWW-Authenticate` |
| `renderMcp(outcome)`         | Task status/message, shared decision metadata and optional caller authorization challenge; the application owns the MCP wire/task lifecycle      |
| `renderCli(outcome)`         | `{exitCode, output, waitUrl}` for an application CLI; caller step-up exits 2, denial exits 1                                                     |
| `stepUpChallenge(operation)` | RFC 9470 header retaining the policy's `acr` and `max_age`                                                                                       |

When policy lets the agent's owner approve, `renderMcp` returns `input_required` with one URL elicitation keyed `ownerApprovalInputKey(approvalId)`, that is `owner_approval:<approvalId>`. MCP Tasks forbids reusing an input-request key, so a fresh approval (after the last one expired) gets a fresh key. **Breaking:** before this, the key was the bare `OWNER_APPROVAL_INPUT` (`owner_approval`); code that read `inputRequests[OWNER_APPROVAL_INPUT]` must look the key up with `ownerApprovalInputKey(operation.approvalId)` or match the `owner_approval:` prefix. Accepting the elicitation never approves anything: the decision is made on the hosted page.

Headless hosts cancel a task that asks for input: Claude Code does in `claude -p`, Agent SDK and GitHub Actions runs, which withdraws the request. For those, call `renderMcp(outcome, { ownerPrompt: "status" })` (or `outcome.toMcp({ ownerPrompt: "status" })`): the task stays `working` and `statusMessage` carries the approval link, so the owner approves on the page out of band.

`operationUrl` and `reviewUrl` options customize public links. Restrict operation status to the initiator and eligible reviewers through the service API. The SDK does not own a worker or polling loop. The refund-desk CLI shows a complete `--wait` implementation.

## Delayed dispatch and uncertain outcomes

Business prerequisites may delay a permitted side effect. Use `prepareOnly: true` to register without claiming or requesting review (the outcome is `approval_required` with no `reviewUrl`; no reviewer is notified), persist the operation reference durably, and resume the same guard with a fresh `operations.get(id)` snapshot:

```ts
const outcome = await authority.protect(
  "refund:create",
  () => {
    throw new Error("Already registered");
  },
  executeRefund,
  {
    operation: await authority.operations.get(operationId),
    executor,
    executionKey: operationKey,
    businessStateVersion: currentPaymentVersion,
    reconcile: async (claim) => {
      // Read-only lookup: never replay a provider mutation under an uncertain claim.
      const refund = await provider.lookupByIdempotencyKey(operationKey);
      if (!refund) {
        await claim.report("not_submitted");
        return null;
      }
      await claim.report(refund.status, refund.id);
      return refund;
    },
  },
);
```

The separate `reconcile` callback receives `ClaimReconcile`; `execute` receives only `ClaimAuthorized`. Without a reconciliation callback, an uncertain claim returns `executed: false` with `reasonCode: "reconcile_required"`. `not_submitted` releases authority only after the provider conclusively has no record. An uncertain provider response must be reported as `unknown` and reconciled before another dispatch attempt. Outcome reports are customer attestations, never provider-verified evidence.

Once the prerequisites hold, resume without `prepareOnly` (or call `approvals.request`) to open the review. `refreshApproval: true` asks the service to recheck or supersede a stale reviewer decision following a claim refusal such as lost approver eligibility. It never lowers a requirement.

## SDK surface

| Namespace        | Methods                                                                                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegations`    | `create(input)`, `get(id)`, `revoke(id, {reason?, subject?})`                                                                                                                                                                                                                                 |
| `operations`     | `register(input)`, `get(id, {accessToken?})`, `cancel(id, {reason?})`, `authorizeAndClaim(input)`, `reportOutcome(input)`                                                                                                                                                                     |
| `approvals`      | `request({operationId, permission?, reviewerHint?})`, `get(id, {accessToken?})`, `list({status?, accessToken?})`, `lease(id, {accessToken?})`, `decide(id, {accessToken, decision, operationDigest})`, `decideBatch({accessToken, decisions})`, `escalate(id, {reviewerSubject})`, `poll(id)` |
| `audit`          | `list(operationId)`, `query({correlationId?, operationId?, delegationId?, type?, reason?, limit?, after?})`                                                                                                                                                                                   |
| `usage`          | `get(day?)`                                                                                                                                                                                                                                                                                   |
| `providerEvents` | `report({organizationId, providerReference, claimId?, action, resource})`                                                                                                                                                                                                                     |
| Client           | `protect(...)`, `withCorrelationId(id)`                                                                                                                                                                                                                                                       |

`operations.register` accepts canonical `arguments`, optional `facts`, optional raise-only `approvalAssertion`, business-state version, expiry, task id and an optional explicit idempotency key. The verified initiating token travels in a subject header; it is never placed in the operation body or URL.

`authorizeAndClaim({operationId, operationDigest, executionKey, businessStateVersion?})` returns `authorized`, `reconcile_required` or `denied`. Authorized and reconciliation results carry `claim.report(status, providerReference?)`, supporting `succeeded`, `failed`, `pending`, `unknown` and `not_submitted`. Policy refusals return data with `code`, `reason`, `retryable` and `correlationId`; transport and contract errors throw `TaskAuthorityError` with `code`, `status`, `retryable`, `correlationId` and `details`.

Reviewer queue and lease eligibility is checked live by the service. Batch decisions contain up to five `{approvalId, decision, operationDigest}` entries for one action. Routine session-tier approvals require fresh MFA and, by default, a DPoP-bound reviewer token (a tier can explicitly make DPoP optional). An eligible reviewer with DPoP can reject without another factor. Use a DPoP-capable OAuth client for the HTTP API. Per-operation review uses confidential PAR/RAR or a service-issued challenge. See the refund-desk reviewer implementation.

CIBA is **explicit escalation only**: call `approvals.escalate(approvalId, {reviewerSubject})`, then `approvals.poll(approvalId)` when checking provider progress. `approvals.request` has no channel or named-reviewer option, and `protect` never sends a push notification. An escalation reviewer subject is an unverified routing hint until the service verifies a resulting token.

`providerEvents.report` requires a trusted backend with `provider-events:write`. Verify the provider webhook signature before forwarding evidence. The service compares evidence with recorded claims and emits `bypass.detected` for unmatched side effects.

## Retries and boundaries

Retries are bounded (default two) with backoff, for network errors, `authorization_unavailable`, `rate_limited` and `internal_error`. Every POST receives an `Idempotency-Key`, reused across retries of that call. The SDK never calls or retries the provider itself. Use a stable `operationKey` and provider idempotency key for one logical side effect.

Keep API, executor and auditor credentials separate. Recheck business state immediately before claiming. The resource server owns its task persistence, worker, business validation and provider credentials; Task Authority owns policy decisions, approval records, leases, claims and authorization audit state.

Optional `@task-authority/sdk/mcp-tasks` exports `principalFromMcpAuth`, `operationKey` and `describeAuthority`. The SDK exports `TaskAuthorityError`, `AuthorizationRequired`, shared types and error-code constants. A second application using the low-level claim contract is `demo/deploy-gate/src/deploy.ts`.
