# Refund Desk (customer reference application)

A merchant-returns agent over **MCP Tasks 2026-07-28**. It owns the MCP receiver, task persistence, the worker, business rules and the provider adapter. It does **not** own delegation, approval, claim or FGA state: that is the separately deployed Task Authority service, reached only through `@task-authority/sdk`.

## Files

| File                                    | Owns                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `src/workflow.ts`                       | The protected workflow: `authority.protect` preparation and claimed execution |
| `src/refund.ts`, `src/policy.ts`        | Business facts and the business eligibility and exception-note requirements   |
| `src/tasks.ts`                          | Task lifecycle, worker ticks, retries, status mapping                         |
| `src/mcp.ts`                            | `server/discover`, `tools/call`, `tasks/get                                   | update | cancel`, error codes |
| `src/auth.ts`                           | `@auth0/auth0-api-js` verification, RFC 9728 metadata, OBO exchange           |
| `src/payments.ts`                       | Stripe **test-mode** adapter (live keys refused) and a labelled simulator     |
| `src/warehouse.ts`, `src/repository.ts` | Signed event ingress; task persistence (no authorization tables)              |

## Run

```sh
cp .env.example .env     # see the file for every variable
npm run build:web
npm run dev:demo         # app + worker loop; the Task Authority service must already be running
```

Set `PAYMENTS_MODE=stripe-test` with an `sk_test_` key for real Stripe test-mode refunds; otherwise the simulator is used and the page banner says so. `DEMO_MODE=1` mounts the operator-only scenario controls (nonproduction).

MCP client: the endpoint is `/mcp`; protected-resource metadata is at `/.well-known/oauth-protected-resource`. The client must send `_meta["io.modelcontextprotocol/protocolVersion"] = "2026-07-28"` and declare `io.modelcontextprotocol/tasks`; otherwise `request_refund` returns `-32021` and creates nothing. Tested clients: a deterministic compliant test client only. No mainstream client has been tested.

Tools: `request_refund` (task), `create_test_payment`, `get_payment`.

## Protected transports

Publish and activate a refund policy in Task Authority whose `resource_server` equals `MCP_AUDIENCE`; this one Auth0 API identifier governs every transport. Unconfigured actions are denied.

MCP `request_refund`, `POST /v1/refunds` and the CLI use the same `RefundService` and `authority.protect` guard. The service evaluates versioned approval rules from canonical arguments and recorded facts. The demo keeps business validation and exception-note collection locally.

```sh
REFUND_ACCESS_TOKEN=<access-token> npm run refund -w @task-authority/refund-desk -- request.json --wait
# Or use the configured native client and device authorization:
npm run refund -w @task-authority/refund-desk -- request.json --login --wait
```

REST returns `202` with `Location: /v1/operations/{id}` and a reviewer link while work is pending. The operation endpoint re-verifies the initiator or eligible reviewer token. The CLI follows that URL with `--wait`, returns exit 1 for denial/rejection/failure, 2 for caller step-up and 3 for timeout. A warehouse return is still required before the worker dispatches, on every transport. Allowing an operation does not skip that business prerequisite.

Verified clients in `HUMAN_CLIENT_IDS_JSON` can initiate directly without an agent delegation. Agent identities continue to come from `AGENT_BY_CLIENT_JSON`; both are verified client ids, never request fields.

```ts
const result = await authority.protect(
  "refund:create",
  () => ({
    operationKey,
    resource,
    arguments: canonicalArguments,
    facts,
    initiator,
  }),
  async (claim) => {
    const refund = await payments.refund(
      command,
      mintDispatchGrant(claim.claimId, operationKey),
    );
    await claim.report(refund.status, refund.refundId);
    return refund;
  },
  { executor },
);
```

For warehouse-delayed execution, use `prepareOnly: true` (it registers but does not open the approval; the review is requested once the return is verified), persist the operation reference, and resume the same guard with `operation` once the return is verified. The execute callback is reachable only after `authorizeAndClaim`. Provider uncertainty goes through read-only reconciliation before retrying.

## Reviewing

`/review.html` shows the current eligible queue, full operation details and leases. Routine reviews reuse an MFA session with DPoP. High-value reviews use fresh WebAuthn-first step-up and a service-issued digest challenge. CIBA is available through the service's explicit escalation endpoint and is never started by normal refund requests.

With `REVIEWER_PAR_ENABLED=1`, a confidential backend sends RAR details to Auth0 `/oauth/par`, uses PKCE and an HttpOnly transaction cookie, and keeps the resulting access token server-side. Reviewers can select up to five displayed operations for the same action and organization and confirm the set once. Configure the backend client id/secret, its callback at `/api/reviewer/callback`, allowed reviewer clients and the Auth0 Enterprise HRI add-on. Configure the Task Authority Auth0 API with `consent_policy: "transactional-authorization-with-mfa"` and a customized consent prompt that renders each RAR entry. This is API configuration, not a PAR parameter. Auth0 presents that prompt after WebAuthn, and the demo asks for a final confirmation of the displayed set. See [Auth0 RAR configuration](https://auth0.com/docs/get-started/apis/configure-rich-authorization-requests) and [PAR protocol](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow/authorization-code-flow-with-par). Pending reviewer logins expire after five minutes and are held in process memory; a restart requires signing in again. Live-tenant PAR/RAR still requires deployment verification.

## Provider reconciliation

`/api/provider/refunds` verifies Stripe webhook signatures, rejects live-mode events and forwards refund evidence to Task Authority. Configure `STRIPE_WEBHOOK_SIGNING_SECRET` and the trusted merchant's `STRIPE_ORGANIZATION_ID`, and grant the API backend `provider-events:write`. Refund dispatch tags Stripe metadata with the authorized claim id; unmatched webhook refunds generate the service's `bypass.detected` event. The provider event is evidence, never execution authority.

## What this app deliberately does not do

No grant/approval/claim tables, no FGA checks, no approval-by-boolean, no reading service tables (`scripts/check-boundaries.mjs` enforces this). A compromised worker with provider credentials could still refund without a claim; the adapter's grant check is an in-process control.

## Honest status

Executed: protocol conformance, eight security scenarios, real process restarts, signed warehouse ingress, adapter contract against a **fake** Stripe server. Not executed: real Auth0 login/MFA/OBO/RAR, Stripe test mode, a mainstream MCP client, deployment.
