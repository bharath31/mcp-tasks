# Refund approval step-up flows

This page covers Policy Desk's default custom-backend mode (`APPROVAL_MODE=authority`), not the separate experimental `approve()` proof path. The backend runs in the Worker; the Actions below run in Auth0 during login.

By default every Policy Desk refund that needs a human is approved with a fresh passkey or security key, bound to that one refund. A code (email, Guardian OTP, SMS or push) never approves a refund by itself.

**Demo opt-in for reviewers without a passkey device.** A sandbox can turn on "Accept authenticator apps for routine approvals" (at sandbox creation, or in Policy; the setting is `allowAuthenticatorApp`). The routine tier's `factors` then also list `otp`, so a fresh authenticator-app code (TOTP) approves routine refunds. It is still per operation: the code must come after the service's challenge for that one refund, and the sign-in's own MFA never counts. High-value refunds always need a passkey or security key. The page sends `task_authority_factor=webauthn_or_otp` for such an approval, and the Action offers or enrols a passkey or an authenticator app. A policy change applies to new requests only, so a refund already waiting keeps the factors it was registered with. Rejecting moves no money, so a signed-in reviewer whose token is bound to their browser (DPoP) rejects with no second factor.

This page lists every path through the approval step-up, what the reviewer sees, what the service decides, and which test covers it.

## How one approval runs

1. The reviewer presses **Approve**. For a WebAuthn-only policy the page checks that the browser supports it (the routine TOTP opt-in skips this prerequisite), then asks the service for a challenge bound to the approval, its digest, the reviewer and the browser's DPoP key.
2. The page sends the reviewer to Auth0 with `task_authority_challenge`, `task_authority_factor=webauthn`, the MFA `acr_values` and the `approvals:decide` scope. It sends no `max_age`, so a reviewer whose Auth0 session is still active does not type the email code again.
3. `auth0/actions/task-authority-approval.cjs` picks the second factor:
   - a passkey or security key enrolled: challenge it, and offer nothing else;
   - none enrolled: enrol one. If the reviewer has a Guardian OTP, push or SMS factor, Auth0 first asks for it once, because Auth0 only adds a factor after a challenge with an existing one.
4. `auth0/actions/task-authority-assurance.cjs` writes the factor that completed the **latest** MFA into the token (`amr`), with its time and the challenge.
5. Back on the page, the decision is replayed with **the token the step-up just issued** (the decide-scope token, read from the cache only). The service accepts it only if `amr` names a WebAuthn factor, the factor time is after the challenge was issued, and the challenge matches.

## What was broken (27 Oct 2026)

A reviewer with no passkey saw two codes and no passkey enrolment, and the approval was refused. The live database showed the decision denied with `mfa_required` at 15:26 UTC, two minutes after its challenge was issued.

- **Wrong token on the replay.** The sign-in token (email code only) and the step-up token sit in the SPA's token cache under different scopes. The replay asked for the sign-in scope, which matches the sign-in token exactly, so the service saw no second factor. Any approval failed this way, passkey or not. The replay now asks for the decide scope from the cache only.
- **A second email code.** The step-up sent `max_age=0`, which makes Auth0 repeat the email sign-in. It added a code and no security: the service checks the second factor's own time, not the sign-in time. It is gone for refund approvals.
- **No passkey enrolment.** The Action also called the classic `api.multifactor.enable("any")` on the refund path, so Auth0 could finish MFA with the existing OTP factor. The refund path now uses only `challengeWith`, `challengeWithAny` and `enrollWithAny`. The classic call remains on the session path, which does not approve refunds.
- **Unclear screens.** Auth0's default Guardian screen says only "Verify your identity". `demo/policy-desk/tools/ul-text.mjs` sets Universal Login text for the OTP, push, SMS and WebAuthn screens, saying why each one appears and that a code never approves a refund. The review panel says the same before the redirect.

## The matrix

"Test" names the file and the test that proves the row. Rows marked _live only_ depend on Auth0's hosted screens or a real authenticator, and are checked by hand after a deploy (see the end of this page).

### Enrolled factors when the reviewer approves

| Reviewer has                                         | Auth0 asks for                                             | Token `amr`                            | Result                                                              | Test                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Nothing                                              | Create a passkey                                           | `mfa`, `webauthn-*`                    | Approved                                                            | `actions-policy.test.ts` "enrols one" (no factor); `flows.test.ts` "fresh passkey"           |
| Only the email factor Auth0 lists for verified users | Create a passkey (email is never challenged)               | `mfa`, `webauthn-*`                    | Approved                                                            | `actions-policy.test.ts` "enrols one"                                                        |
| Guardian OTP                                         | One Guardian code, then create a passkey                   | `mfa`, `webauthn-*` (the later factor) | Approved                                                            | `actions-policy.test.ts` "enrols one" and "names the factor that completed the freshest MFA" |
| Guardian push or SMS                                 | One push or SMS code, then create a passkey                | `mfa`, `webauthn-*`                    | Approved                                                            | `actions-policy.test.ts` "enrols one"                                                        |
| A recovery code only                                 | Create a passkey (a recovery code is not challenged first) | `mfa`, `webauthn-*`                    | Approved                                                            | `actions-policy.test.ts` "enrols one"                                                        |
| Platform passkey                                     | That passkey only                                          | `mfa`, `webauthn-platform`             | Approved                                                            | `actions-policy.test.ts` "asked for that passkey only"                                       |
| Security key only                                    | That key only                                              | `mfa`, `webauthn-roaming`              | Approved                                                            | `actions-policy.test.ts` "asked for that passkey only"; `flows.test.ts` "fresh one does"     |
| Passkey and OTP                                      | The passkey only, no OTP offered                           | `mfa`, `webauthn-*`                    | Approved                                                            | `actions-policy.test.ts` "asked for that passkey only"                                       |
| Any token whose latest factor is OTP                 | (an older Action, or enrolment not counted as MFA)         | `mfa`, `otp`                           | Refused `factor_not_satisfied`; the page says "press Approve again" | `flows.test.ts` "fresh passkey" (OTP step-up)                                                |

If Auth0 does not report the passkey enrolment itself as an MFA method, the first approval after enrolment ends on the OTP and is refused with `factor_not_satisfied`, and the next one challenges the new passkey. That is safe and the page says so; whether the extra press happens is _live only_.

### When the sandbox accepts authenticator apps (routine tier only)

| Reviewer has                  | Auth0 asks for                                    | Token `amr`              | Result   | Test                                                                |
| ----------------------------- | ------------------------------------------------- | ------------------------ | -------- | ------------------------------------------------------------------- |
| Nothing                       | Pick and set up a passkey or authenticator app    | `mfa`, `otp` or WebAuthn | Approved | `actions-policy.test.ts` "a tier that accepts an authenticator app" |
| Authenticator app             | One fresh code                                    | `mfa`, `otp`             | Approved | `flows.test.ts` "a sandbox that opts in approves a routine refund"  |
| Passkey and authenticator app | The passkey, with the app code as the alternative | `mfa`, either            | Approved | `actions-policy.test.ts` "a tier that accepts an authenticator app" |

### Things that go wrong during the step-up

| Case                                        | What happens                                                                                                                                                                                  | Test                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Browser without WebAuthn                    | Approve is explained as unavailable and the page refuses before asking for a challenge (`webauthn_unavailable`); reject still works                                                           | _live only_ (page logic in `web/src/api.ts` `startHighValue`)                                                     |
| Passkey enrolment cancelled or fails        | Auth0's WebAuthn error screen offers a retry. If the reviewer goes back to the page, the replay finds no step-up token and says "Auth0 did not finish the passkey step, nothing was approved" | _live only_ for the screen; replay path in `web/src/auth.ts` (`STEP_UP_INCOMPLETE`)                               |
| Wrong Guardian code                         | Auth0 shows its invalid-code error and lets the reviewer retry; Auth0 limits attempts                                                                                                         | _live only_ (Auth0)                                                                                               |
| Guardian code expired                       | Auth0 asks for the current code                                                                                                                                                               | _live only_ (Auth0)                                                                                               |
| Auth0 returns `?error=`                     | The page keeps the sign-in, drops the pending decision and says nothing was recorded                                                                                                          | `web/src/auth.ts` `initAuth`, `web/src/main.ts`                                                                   |
| Auth0 session ended before the step-up      | Auth0 asks for the email code, then the passkey                                                                                                                                               | _live only_                                                                                                       |
| Replay uses the sign-in token               | Refused `mfa_required` (the 27 Oct bug); the page now sends the step-up token                                                                                                                 | `step-up-params.test.ts` "sends the step-up token"; `flows.test.ts` "plain login"                                 |
| Passkey from a sign-in before the challenge | Refused (`step_up_stale_or_before_request` or `challenge_not_bound_to_operation`)                                                                                                             | `flows.test.ts` "a passkey from a sign-in before the challenge"                                                   |
| The same step-up token used twice           | Refused `token_replayed`                                                                                                                                                                      | `auth0/tests/service/security.test.ts`; `auth0/tests/e2e/fullstack.test.ts` (single-use token survives a restart) |
| A recent sign-in MFA                        | Does not skip the per-refund passkey                                                                                                                                                          | `actions-policy.test.ts` "recent sign-in MFA"                                                                     |
| Agent token or unverified email at Auth0    | Denied before any factor                                                                                                                                                                      | `actions-policy.test.ts` "agents and unverified emails"                                                           |

### Who decides, and how

| Case                                                   | Rule                                                                        | Test                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Approve, separate reviewer                             | Fresh WebAuthn bound to the refund                                          | `flows.test.ts` "fresh passkey"                                  |
| Reject, DPoP-bound sign-in                             | No second factor, no freshness check; still bound to the digest and audited | `flows.test.ts` "device-bound reviewer rejects"                  |
| Plain login bearer token used to reject or approve     | Refused `mfa_required`                                                      | `flows.test.ts` "device-bound reviewer rejects"                  |
| DPoP-bound token sent as bearer, or a replayed proof   | Refused                                                                     | `security.test.ts` "refuses a DPoP-bound token sent as Bearer"   |
| Owner approving their own agent (self-approval policy) | Always a fresh passkey, never a review session, never OTP                   | `auth0/tests/service/owner-approval.test.ts`                     |
| Owner without a self-approval policy                   | Refused (separation of duties)                                              | `owner-approval.test.ts` "separation of duties is the default"   |
| Initiator approving their own request                  | Refused `initiator_cannot_approve`                                          | `auth0/tests/service/security.test.ts`, `owner-approval.test.ts` |

### Agents and sandboxes

| Case                                                  | What happens                                                                                  | Test                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| External agent (Claude Code) with a sandbox agent key | Its refund waits for the visitor's fresh passkey like any other                               | `agent-key.test.ts` "waits for the visitor's fresh passkey"                    |
| Unbound token of the external agent client            | Refused                                                                                       | `agent-key.test.ts` "unbound token"                                            |
| Built-in agent, MCP task waiting on approval          | The refund waits for a person and runs once after approval                                    | `agent.test.ts` "a larger one waits for a person and runs once after approval" |
| Sandbox reset between the challenge and the return    | The old approval is gone; the decision is refused                                             | `flows.test.ts` "a sandbox reset between the challenge and the return"         |
| Sandbox expires mid-approval                          | The decision may still record in Task Authority, but the refund never runs: `sandbox_expired` | `flows.test.ts` "a sandbox that expires mid-approval"                          |

## Deploying the current implementation

1. Deploy the Worker and web bundle: `npm run build`, then `npm run deploy` for your own root-config deployment. Only the maintainer should use `npx wrangler deploy --config demo/policy-desk/wrangler.jsonc` (it contains the maintainer's domain and tenant).
2. Update/deploy both managed Actions from `auth0/actions/task-authority-approval.cjs` and `auth0/actions/task-authority-assurance.cjs`, in that order. `npm run setup` reconciles them; `npm run verify` checks deployed code and binding order without changing them.
3. Set the Universal Login text: `node demo/policy-desk/tools/ul-text.mjs --tenant <tenant>` (dry run), then add `--apply`.

## Checking it live

With a reviewer account that has only Guardian OTP, and one with no factors:

1. Ask the agent for a refund above the threshold, then press Approve.
2. Expect no email code (the Auth0 session is active). The OTP account sees the Guardian screen with the new text, then the passkey creation screen; the empty account sees passkey creation only.
3. Back on the page, expect "Approved". If it says `factor_not_satisfied`, press Approve once more and expect only the passkey prompt; note it here, because then Auth0 does not count enrolment as MFA.
4. Approve a second refund: expect the passkey prompt only.
5. Reject a refund: expect no Auth0 redirect.
