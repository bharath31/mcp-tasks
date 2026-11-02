# Policy Desk (backend)

A Cloudflare Worker that hosts the **real Task Authority service** (`auth0/service/src/http.ts`, imported not copied)
next to a small refund app, so a visitor with a real Auth0 login can experience channel-agnostic approval policy.
The browser UI lives in `web/` and is served from `web/dist` through the Workers `assets` binding (SPA fallback).
The HTTP contract for the UI is [`API.md`](API.md). What the deployer must create is in
[`PROVISIONING.md`](PROVISIONING.md).

```text
Browser (Auth0 SPA) ──► Worker
                        ├─ /sandbox/*      host API (me, reset, scenario, state, progress, policy, ...)
                        ├─ /v1/refunds*    refund app (authority.protect, simulated payments)
                        ├─ /v1/*           real Task Authority service, tenant = the caller's sandbox
                        └─ everything else static assets
Postgres (Hyperdrive): schema authority (service) + schema policy_desk (this demo)
Auth0: login, MFA, DPoP, Actions, M2M clients     Auth0 FGA: relationships
```

## Experimental `approve()` mode

Policy Desk defaults to `APPROVAL_MODE=authority`. For a local evaluation of the Auth0-signed passkey path, initialize a dedicated approval app for this Worker and write its local credentials here:

```sh
npm run task-authority -- approve init \
  --tenant <your-tenant>.us.auth0.com \
  --app-url http://localhost:8787 \
  --app-name "Policy Desk" \
  --connection email \
  --role finance \
  --vars-path demo/policy-desk/.dev.vars
```

Policy Desk uses email OTP for sign-in, with no password connection enabled for the dedicated approval app. The command writes `AUTH0_APPROVAL_CONNECTION=email` and `AUTH0_APPROVAL_LOGIN_METHOD=email-otp` alongside the app credentials. It installs the ordered `agent-approval-mfa` and `agent-approval-assurance` Actions: email OTP starts sign-in, but only a fresh WebAuthn platform or security-key MFA challenge can stamp the approval proof. The tenant must have WebAuthn MFA enabled and reviewers must enroll a key; this may require a paid MFA/custom-factors tier. The unqualified `approve()` SDK path continues to require its default first-factor passkey. Neither approval path has been verified on a live tenant yet; see [docs/approve.md](../../docs/approve.md).

Set `APPROVAL_MODE=approve` and `APPROVAL_ROLE=finance` in `demo/policy-desk/.dev.vars`, assign that Auth0 role to the human reviewers, and run the owner migration tool before starting the Worker:

```sh
OWNER_DATABASE_URL='postgres://…' node --import tsx demo/policy-desk/tools/migrate.ts
npx wrangler dev --config demo/policy-desk/wrangler.jsonc --port 8787
```

The request stays a working MCP Task until a reviewer completes the hosted page. `tasks/get` verifies and consumes the proof before issuing the simulated refund. The mode is experimental; it does not use Task Authority policy decisions, and it must not be enabled in the hosted demo without a separate deployment review.

The chat's **Review this refund** action comes from structured server metadata. The server strips the signed approval URL from the model-facing result and saved chat history, so the assistant points reviewers to that button instead of printing the token link.

## What is real and what is simulated

Agent identity: the agent is a real Auth0 M2M client; its delegation is user-owned by a separate real user, Alex, whose
refresh token (set once by `tools/alex-login.mjs`) the Worker exchanges when it must (re)create the delegation, so the
visitor is always free to review what the agent requests.

Real: Auth0 tokens verified against the tenant JWKS, MFA/step-up/DPoP checks of the service, Auth0 Actions claims, FGA
checks and writes, policy publish/activate/simulate through `/v1/policies`, budgets, audit. Simulated: payments
(`policy_desk.orders` and `refunds`, labelled "simulator"; no provider key is ever read) and warehouse events (not used).

## Isolation and cleanup

- One real user = one sandbox `sbx_<hash(sub)>` = one service tenant `pd_<id>_g<generation>`; every service query is
  tenant-scoped. `POST /sandbox/reset` starts a new generation (fast, idempotent).
- All demo data is in `policy_desk.*` or rows with the demo's tenant ids in `authority.*`. FGA tuples for visitors are
  written to the configured FGA store.
- The scheduled handler (`*/5 * * * *`) deletes sandboxes older than 15 minutes and superseded generations. The service
  tables `audit_events` and `policy_versions` are append-only by trigger; cleanup disables just those two triggers inside
  one transaction and only deletes rows whose tenant id matches `pd_<24 hex>_g<n>`.

## Guardrails (all server-side)

| Guardrail                                                                                                                                                                                                         | Where                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Max 10 pending approvals per sandbox (`quota_exceeded`)                                                                                                                                                           | service tenant quota `openApprovals`, `src/host.ts` |
| Max 3 open delegations, 200 claims/day, 240 requests/min                                                                                                                                                          | service tenant quotas, `src/host.ts`                |
| Max 50 operations per sandbox generation                                                                                                                                                                          | `src/refunds.ts`                                    |
| Max 40 orders per generation                                                                                                                                                                                      | `src/orders.ts`                                     |
| Max 10 policy publishes per hour                                                                                                                                                                                  | `src/seed.ts` (`publishPolicy`)                     |
| Policy edits only 4 numbers inside ranges; approver floor and `unknown_action: deny` fixed in code                                                                                                                | `src/policy.ts`                                     |
| Per-IP (hashed) and per-user fixed windows in Postgres: reads 600/10 min, writes 60/10 min, resets 10/h per IP and 6/h per user, 5 new sandboxes/day per IP, scenarios 40/10 min, policy 20/h, simulate 20/10 min | `src/api.ts`, `src/ratelimit.ts`                    |
| Global cap of 500 active sandboxes                                                                                                                                                                                | `src/api.ts`                                        |
| 24 hour sandbox TTL (410 after expiry)                                                                                                                                                                            | `src/refunds.ts`, `src/api.ts`, `src/cleanup.ts`    |
| Visitors get no `policies:write`; policy publishing uses the admin M2M client held by the Worker                                                                                                                  | `src/seed.ts`                                       |

## Adaptations of refund-desk (the customer app)

`demo/refund-desk` is Node-oriented (MCP Tasks service, warehouse stage, worker loop, `stripe`, `@auth0/auth0-api-js`).
Reused unchanged: `policy.ts` (`isEligible`), `refund.ts` (`stateVersion`), the SDK `protect`/`renderRest`/`renderCli`/`renderMcp`.
Adapted in `src/refunds.ts`, `src/orders.ts`: a slim REST-only refund app (no MCP `/mcp`, no warehouse return stage), a simulator
over `policy_desk` tables instead of `refund_desk.sim_*` (the original imports the Stripe SDK and a Node `pg.Pool`), and the
refund-desk migration is **not** applied (it holds only MCP task/warehouse tables). `/mcp` returns 404.
Node-only service pieces: `auth0/service/src/store.ts` reads its migration folder from `import.meta.url` at load; `wrangler.jsonc`
`define`s that constant, and `src/db.ts` supplies a per-request `Store`-shaped object with identical transaction semantics.

## Operator usage page

`/admin` shows visitors, sandbox activity, approvals, simulated refunds, and model
calls/tokens. Lifetime totals survive sandbox cleanup; the 7/14/30-day selector
filters the activity chart. First seen means the first authenticated sandbox API
visit after usage tracking ships, rather than the Auth0 signup date.

Access is checked server-side against comma- or whitespace-separated `ADMIN_SUBS`
(exact Auth0 subjects) or `ADMIN_EMAILS` (case-insensitive verified emails).
Neither configured means nobody has access. The SPA sends `X-Id-Token`; the Worker
verifies its issuer, signature, SPA audience, expiry and subject before using its
email. A stored visitor email never grants access.

Deployment handoff: run the owner migration tool to apply `0004_usage.sql` and
refresh runtime grants, then configure the operator allowlist before deploying.
This PR does not apply migrations, set secrets or modify Auth0 configuration.

The AI agent calls `recordModelCall` from `src/usage.ts` once per model invocation,
including failed calls. Workers AI `usage.prompt_tokens` and
`usage.completion_tokens` map to the input/output token fields; failures without
usage metadata leave token counts unknown. Until the first call, the page shows
that no model calls have been recorded.

Build with `npm run build:web`. `/admin?mock=1` renders design fixtures without
Auth0. Run `npm run test:admin` with Chromium installed (or set `CHROMIUM_PATH`)
for the responsive UI, search, range and access-state checks. Set
`ADMIN_SCREENSHOT_DIR` to save desktop and mobile screenshots.

## Connecting your own agent (agent keys)

The console's Agent page has **Connect your own agent**. It issues a sandbox agent key and
shows a ready command:

```sh
claude mcp add --transport http policy-desk https://<host>/mcp \
  --header "Authorization: Bearer <agent key>"
```

Then ask Claude Code (CLI, interactive, so MCP Tasks are on) for a refund. Small refunds
complete at once; larger ones come back as a `working` task whose status message links to
the review page, where you approve with a fresh passkey. Claude Code picks the result up
with `tasks/get`. The same key works on `POST /v1/refunds` for a script or CLI.

How the key works (`src/agent-keys.ts`):

- It is a real Auth0 client-credentials token of the **Policy Desk External Agent** M2M
  client (`EXTERNAL_AGENT_CLIENT_ID` / `_SECRET`), minted fresh for the visitor. The Worker
  signs nothing; it stores only a SHA-256 of the token in `policy_desk.agent_keys`, bound to
  one sandbox.
- Tokens of that client are accepted **only** through the binding. The sandbox comes from the
  binding, never from the request (a mismatching `x-policy-desk-sandbox` is refused with
  `wrong_sandbox`). A new key replaces the old one, `DELETE /sandbox/agent-key` revokes it,
  and TTL cleanup deletes keys with their sandbox, so a leaked key dies with the sandbox at
  the latest even if the token is still unexpired.
- The key acts as the sandbox's refund agent, under Alex's delegation, exactly like the
  built-in agent. That is why you, the visitor, may approve what it requests. Nothing is
  relaxed: Task Authority decides every refund, and the approval still needs your passkey.
- Limits: 5 keys per visitor per hour and 200 per day overall (each is one Auth0 M2M token).

Without `EXTERNAL_AGENT_CLIENT_ID` the panel says it is not set up and the endpoint answers
503 `not_configured`. `tools/provision.mjs` creates the client (no scopes; grant on the Task
Authority audience) and `tools/setup.mjs` pushes its secrets.

## Signing in from an MCP host (Claude Code)

This is the standards path, and the harder one for a solo tester: a host that signs in on
its own gets a token for **you**, so you become the requester and policy keeps you from
approving your own refund (another reviewer must). Use an agent key to try the full loop
alone.

`/mcp` publishes RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp`, and a 401 from `/mcp` carries
`WWW-Authenticate: Bearer resource_metadata="..."`. A host that follows the MCP
authorization spec discovers the Auth0 tenant from it, signs the user in and sends
`resource=<origin>/mcp` (RFC 8707). The Worker accepts tokens whose audience is that
resource (`MCP_RESOURCE` overrides it) on `/mcp` only.

The tenant needs, once:

1. An API whose identifier is `https://<host>/mcp` (offline access allowed).
2. The resource parameter compatibility profile, so Auth0 reads `resource` as the audience.
3. A client for the host. Prefer a pre-registered native client with
   `organization_usage: "require"` and `organization_require_behavior: "pre_login_prompt"`
   (the sandbox token must carry the demo org) and the email connection enabled, then
   `claude mcp add --transport http --client-id <id> --callback-port 8765 policy-desk https://<host>/mcp`
   with `http://localhost:8765/callback` in its callbacks. Dynamic client registration also
   works, but registered clients are third-party and get no organization by default.

Sign in on the web console and create the sandbox first; `/mcp` answers 404
`sandbox_not_initialized` until then.

## Local development and tests

```sh
node --import tsx --test --test-concurrency=1 demo/policy-desk/tests/*.test.ts
```

Needs local Postgres on `127.0.0.1:55432` (same as `auth0/tests/helpers/pg.ts`). Tests start the stand-in IdP
`auth0/tests/helpers/oidc-server.ts` (test only, not Auth0) and use `ALLOW_LOCAL_FGA=1` (Postgres tuple table).
`ALLOW_LOCAL_FGA` is refused unless set explicitly; deployed mode requires `FGA_API_URL` and `FGA_STORE_ID`.

`wrangler dev --local` needs `.dev.vars` (see `.dev.vars.example`) and the Hyperdrive `localConnectionString`
(a local Postgres database named `policy_desk_dev`). Do not run `wrangler deploy` from CI without reading `PROVISIONING.md`.

To look at the console without Auth0 or the Worker, `npm run preview:policy-desk` builds it against in-memory
fixtures (`web/preview/`) and serves it on <http://localhost:8787>. Add `?scene=empty`, `?scene=new` or
`?scene=out` for the other states and `&lat=800` to slow every call down. It is for visual checks only and never
deployed.

## Latency

Most requests make many sequential Postgres round trips (an agent turn makes 60 to 80), so the Worker runs next to
the database, not next to the visitor: `placement.region` in `wrangler.jsonc` names the Supabase region
(`aws:ap-northeast-1`). Move it if the database moves. Every dynamic response carries `Server-Timing` (Postgres
connect, round trips, FGA calls, model calls), which the console's "Requests" menu in the header shows per request, and the
agent streams each model call and MCP exchange as NDJSON while it works.

`tools/measure-flow.ts` counts the round trips behind each request of the whole reviewer flow against the local test
world, as a budget to keep:

```sh
node --import tsx demo/policy-desk/tools/measure-flow.ts
```
