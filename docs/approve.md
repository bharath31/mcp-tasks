# approve(): verified approval as a workflow step

`approve()` makes a human decision one step of a durable workflow, proven by a token Auth0 signs. The engine holds the wait; `approve()` decides whether the event that resumes it is a real decision.

```ts
import { approve } from "@task-authority/sdk/approve/cloudflare";

// in WorkflowEntrypoint.run(event, step)
const ok = await approve(step, event, this.env, {
  action: "refund:create",
  resource: `payment:${paymentId}`,
  args: { paymentId, amountMinor: 15000, currency: "USD" },
  approvers: { roles: ["finance"] }, // or { users: [sub] }, { owner: sub }
  notify: (link) => sendEmail(financeTeam, link),
});
await stripe.refunds.create({ ... }, { idempotencyKey: ok.key });
```

```ts
// in the Worker's fetch handler: the approval page and the Auth0 callback
const res = await approvalRoutes(request, env, { workflow: env.REFUNDS });
if (res) return res;
```

Configuration is four values: `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `APP_URL`. Push approvals add `AUTH0_APPROVAL_AUDIENCE`. The default login is a fresh passkey as the first factor on a database connection. `task-authority approve init --connection email` opts that dedicated app into email OTP followed by WebAuthn MFA and writes `AUTH0_APPROVAL_CONNECTION=email` and `AUTH0_APPROVAL_LOGIN_METHOD=email-otp`. This choice is app-specific; it does not change the generic SDK default. A working example is [demo/refund-workflow](../demo/refund-workflow).

When approvers are explicit user IDs, `approverLabels` can provide display names for the page. Refund arguments with `amountMinor` and an ISO currency code show a formatted amount while keeping the raw minor-unit value visible. Large requests need a trusted `ApprovalStore` (`put(id, request)` / `get(id)`); links switch to a short, signed pointer when the full request would exceed 6 KB. Pass the same store to `approve()` and `approvalRoutes()`.

For long waits, an adapter can take `recheck(approval)` and run it in a separate durable step after token verification. `auth0RolesRecheck(cfg, managementApiToken)` checks that the Auth0 roles required by the request are still assigned. The Management API token needs `read:users` and `read:roles`; this helper is opt-in because the token must be held by the workflow runtime.

When the caller uses a DPoP-bound token, pass its `cnf.jkt` as `requesterJkt`; the approval binding includes it. Push requests may name one user directly or name a role and supply `resolveApprover(request)` to select one current user before CIBA starts. That resolver is also opt-in and must use the application's own role or on-call lookup.

For Cloudflare Agents SDK `AgentWorkflow`, set `agentsSdk: true` on `approvalRoutes()` and pass the returned `metadata` to `verifyAgentsApproval(cfg, request, metadata)`. The built-in `waitForApproval()` throws on rejection before user code can verify the proof, so until Cloudflare adds a verification hook you can only safely use it to continue after a verified approval; its rejection path is not authenticated by this adapter.

Additional adapter entry points are optional and do not add engine packages to the SDK:

| Engine          | Entry point                            | Engine primitive                | Current boundary                                                  |
| --------------- | -------------------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| Inngest         | `@task-authority/sdk/approve/inngest`  | `step.waitForEvent()`           | Invalid events keep waiting; timeout expires the request.         |
| Temporal        | `@task-authority/sdk/approve/temporal` | signal + `condition()`          | Create and verify through Temporal activities; link channel only. |
| Vercel Workflow | `@task-authority/sdk/approve/vercel`   | `createHook()` / `resumeHook()` | Link channel only; hook storage belongs to the Workflow SDK.      |

The adapter files use structural types so apps only install the engine they run. Inngest callers pass `step`, the run ID and `inngest` client to `approveInngest()` and `inngestApprovalRoutes()`. Temporal callers create the signal definition with `defineSignal<[TemporalDecisionSignal]>(TEMPORAL_APPROVAL_SIGNAL)`, pass it to `approveTemporal()`, and proxy request creation and verification through activities; the HTTP callback sends the same named signal. Temporal handlers take a signal definition from `defineSignal()`, so the adapter requires that definition rather than accepting a raw string. Vercel callers pass `createHook`, `sleep`, and `resumeHook` through `approveVercel()` and `vercelApprovalRoutes()`; the hook is iterable so invalid proof events can be skipped while waiting for another delivery. These wrappers are not substitutes for real engine integration tests, which remain outstanding.

Engine-specific details: [Cloudflare Agents workflows](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/), [Inngest waitForEvent](https://www.inngest.com/docs/reference/typescript/v3/functions/step-wait-for-event), [Temporal workflow signals](https://docs.temporal.io/develop/typescript/workflows), and [Vercel Workflow hooks](https://useworkflow.dev/docs/api-reference/workflow/define-hook).

## Why it exists

Durable engines can wait for a human; none of them checks who the human was. Cloudflare's Agents SDK `waitForApproval()` resumes on whatever `approveWorkflow(id, { metadata: { approvedBy } })` sends, and `approvedBy` is a string the caller chooses. Inngest's `waitForEvent` resumes on any matching event. The same holds for Temporal signals and Vercel Workflow hooks. Anyone who can send the engine an event can approve.

`approve()` treats the event as input, not proof. The proof inside it must be an Auth0-signed token that names this exact decision.

## How a proof is made

**Link (Auth0 Free).** The approver opens the link, sees the request rendered from the signed link, and presses Approve or Reject. By default the SDK sends them to Auth0 with `prompt=login`, `max_age=0`, PKCE, and

```
nonce = base64url(sha256("agent-approval:v1|" + canonical({ id, digest, run, step, exp, decision })))
```

where `digest` is the sha256 of the canonical `{ action, resource, args, version }`. OIDC requires Auth0 to return the nonce in the ID token. The [agent-approval Action](../auth0/actions/agent-approval.cjs) runs only on these sign-ins (`agent_approval=1`): it refuses anything but a fresh passkey (`event.authentication.methods[].name === "passkey"`, per [Auth0's post-login docs](https://auth0.com/docs/customize/actions/explore-triggers/post-login)) and adds one claim, `https://task-authority.example/approval = { method, at, roles }`. The ID token that comes back is the proof.

**Optional email OTP login.** `approve init --connection email` marks the dedicated Regular Web App with `client_metadata.task_authority_approval=webauthn-mfa` and binds two Post Login Actions in order: `agent-approval-mfa` challenges or enrolls a WebAuthn platform/security key; `agent-approval-assurance` stamps the proof only if a fresh WebAuthn MFA method completed in the last five minutes. Email OTP alone never creates an approval proof. The tenant must have an enabled WebAuthn MFA factor; the setup checks the tenant factor configuration, while each reviewer must enroll a WebAuthn factor. Enabling MFA or custom factors may require a paid Auth0 tier. The original database passkey first-factor path remains the default for the SDK and for `approve init` without `--connection email`.

**Push (AI Agents add-on).** CIBA to one named approver, with `authorization_details: [{ type: "agent_action", binding, digest, action, resource }]` and a binding message of at most 64 characters. The access token Auth0 issues is the proof. The type must be registered on the API named by `AUTH0_APPROVAL_AUDIENCE`.

**Verification** happens inside the workflow after it resumes, against the workflow's own memoized copy of the request, never the event's:

| Check     | Link                                                 | Push                                                 |
| --------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Signature | Tenant JWKS, issuer, `aud` = client ID               | Tenant JWKS, issuer, `aud` = approval API            |
| Binding   | `nonce` equals the binding for approve or reject     | `authorization_details[].binding` equals the binding |
| Freshness | `auth_time` after the request and before it expires  | `iat` after the request and before it expires        |
| Presence  | Action claim `method: "passkey"`, `at` ≈ `auth_time` | Approved on the enrolled device                      |
| Who       | `sub` in `users`/`owner`, or a role in `roles`       | Same                                                 |
| Not self  | `sub` ≠ `requester`                                  | Same                                                 |

`ok.key` is `apv_` plus a hash of the request id and digest. The same run and step always produce the same key, so a replayed step can't pay twice.

## Guarantees

1. **Exact arguments.** Change one cent and the binding no longer matches.
2. **A real, entitled person.** A fresh passkey sign-in (or a CIBA push) by someone the `approvers` rule allows. The requester never qualifies.
3. **Once.** The proof names this run and step, and the key doubles as the provider's idempotency key.
4. **Forgery doesn't move or end the run.** A refused event is logged and the step keeps waiting, up to `maxInvalid` (default 25) refusals.
5. **Headless-safe.** Nothing waits on an MCP client, so `claude -p`, the Agent SDK and CI runs work.

It does not guarantee that the app showed the approver the truth: the page renders the request from the app's own signed link.

Policy Desk renders its approval action from the server's structured `decision.reviewUrl` metadata. Its model-facing tool result and saved chat history replace the signed URL with short guidance to use the **Review this refund** button; the signed link is not copied into the assistant's reply. The raw MCP exchange and structured UI link remain available to the app, and the browser accepts the CTA only for its same-origin `/approve` route.

## Verified so far

| Claim                                                            | Status                                                                                                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK, Action and routes work end to end                           | Tested: local OIDC provider over TLS, the real Action module, `auth0/tests/sdk/approve.test.ts`                                                                 |
| Cloudflare adapter on a real Workflow                            | Tested: workerd under Miniflare, `auth0/tests/integration/approve-cloudflare.test.ts`                                                                           |
| Policy Desk MCP approve mode                                     | Tested: local OIDC + Postgres, including approve, reject, wrong approver, replay, expiry and idempotent retries (`demo/policy-desk/tests/approve-mode.test.ts`) |
| Task Authority proof bridge                                      | Tested: local OIDC + Postgres, including proof redemption, replay and FGA denial (`auth0/tests/integration/approval-proof.test.ts`)                             |
| A post-login Action sees a passkey first factor                  | Documented by Auth0; not yet run on a live tenant                                                                                                               |
| Auth0 returns our nonce and a fresh `auth_time` with `max_age=0` | Standard OIDC, which auth0-spa-js relies on; not yet run on a live tenant                                                                                       |
| CIBA tokens carry `authorization_details`                        | Not verified on a live tenant (needs the AI Agents add-on)                                                                                                      |

None of the rows above has been run on a live Auth0 tenant, and no adapter has run on a real Inngest, Temporal or Vercel Workflow deployment yet. Treat `approve()` as a tested design, not a proven integration.
