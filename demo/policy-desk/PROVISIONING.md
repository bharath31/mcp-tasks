# Provisioning checklist (real Auth0, real FGA)

> For your own deployment, use the one-click path in [docs/deploy-cloudflare.md](../../docs/deploy-cloudflare.md): `npm run setup` runs everything below (`provision.mjs`, MFA factors, `ul-text.mjs`, the FGA model, migrations with the runtime role, Worker secrets and `alex-login.mjs`) against the root `wrangler.jsonc`, then checks the tenant read-only (`npm run verify`). This page documents what it configures and how to do it by hand.

The default deployed demo uses real Auth0 identity/MFA and FGA checks with the custom approval backend implemented here; payments are simulated. “Task Authority API” below means an Auth0 resource-server registration (audience/permissions) for that Worker-hosted backend, not an Auth0-hosted approval product. Local tests use identity/FGA fixtures, and the experimental `approve()` mode is not live-verified. This list is derived from `auth0/tools/auth0-provision.mjs`
(the test-tenant provisioner), `auth0/actions/*.cjs`, `docs/approval-policy.md`
and `demo/refund-desk/README.md`. The hosted demo runs on a live tenant that was configured by hand and by
these tools over time; **`npm run setup` has never been run end to end against a brand-new tenant**.
The Worker only reads configuration from the variables below. Use a dedicated test tenant.

## 0. Automated Auth0 provisioning (recommended)

`tools/provision.mjs` does steps 1 to 6 of section 1 through the Auth0 CLI (`auth0 login` first, with
scopes for resource servers, clients, client grants, organizations, actions and connections; Node 22, no
dependencies). It is **rerunnable and reconciles managed objects** named `policy-desk` / `Policy Desk`, looking them up by stored id/name. It can update existing managed API settings, clients/callbacks, grants and Action code; it is not create-only. It preserves unrelated post-login bindings and appends its own Actions in the required order. Always inspect a dry run on a tenant that is not new. The higher-level `setup.mjs` additionally changes MFA factors, email-connection configuration and Universal Login text.

```sh
# 1. Dry run (default): prints every planned call with redacted bodies, writes nothing.
node demo/policy-desk/tools/provision.mjs \
  --tenant YOUR-TENANT.us.auth0.com --origin https://YOUR-WORKER-ORIGIN --connection "<existing connection name>"

# 2. Review the plan and the post-login before/after list, then apply. --create-alex also creates the
#    delegating user policy-desk-alex in that (database) connection with a random password that goes
#    only to the state file, marks its email verified and adds it to the policy-desk organization.
node demo/policy-desk/tools/provision.mjs ... --apply --create-alex alex@example.com

# Remove only what this script created. Dry run unless --apply is also given.
node demo/policy-desk/tools/provision.mjs ... --destroy [--apply]
```

Outputs, both outside the repo (the script refuses paths inside it) and written with mode 0600:

- `--state` (default `~/.policy-desk/auth0-state.json`): ids, **client secrets** (including the Agent Owner client)
  and the generated Alex password. Never printed to stdout.
- `--vars-out` (default `~/.policy-desk/wrangler-vars.json`): the non-secret Worker vars
  (`AUTH0_DOMAIN`, `TASK_AUTHORITY_AUDIENCE`, `SPA_CLIENT_ID`, `AUTH0_ORG_ID`, `AGENT_ID`), the client ids, and
  the **names** of the Worker secrets to set with `wrangler secret put` (`secrets`, plus `manualSecrets` for
  the ones the script cannot create).

It only reports (never changes) tenant-wide facts, and prints an `ACTION NEEDED BY HUMAN` section for them:
WebAuthn factors off, connection sign-up disabled, DPoP/RAR availability on the tenant, and Alex's one-time login.
If the tenant rejects the DPoP or RAR fields on the API, the script continues without them and says so.

**Manual maintainer path:** the standalone `put-secrets.mjs` and `alex-login.mjs` helpers target `demo/policy-desk/wrangler.jsonc`, which contains the maintainer's deployment. Do not use them unchanged for a root-config user deployment; use `npm run setup`, which overrides the secret destination. The sequence below describes those maintainer helpers, not the deploy-your-own path.

**Order** (secrets are passed over stdin rather than command arguments):

1. `provision.mjs ... --apply --create-alex <email>`: Auth0 objects, Alex and the "Policy Desk Agent Owner"
   confidential client (regular web app, authorization code + refresh token, callback
   `http://127.0.0.1:53682/callback`, **non-rotating** refresh tokens, organization usage allowed, user grant on
   the Task Authority API with no scopes; the API already allows offline access).
2. Build with `npm run build:web` and deploy the intended maintainer config (`npx wrangler deploy --config demo/policy-desk/wrangler.jsonc`), then
   `node demo/policy-desk/tools/put-secrets.mjs --apply`: pushes every client id/secret (including
   `AGENT_OWNER_CLIENT_ID/SECRET`) with `wrangler secret put` over stdin.
3. `node demo/policy-desk/tools/alex-login.mjs`: opens the browser once. Sign in as Alex with the email you gave
   `--create-alex`; the password is in the state file under `alex.password` (or use "Forgot password"). The script
   exchanges the code (PKCE) and pipes the refresh token straight into `wrangler secret put
AGENT_OWNER_REFRESH_TOKEN`. Nothing is printed or written elsewhere. Errors it reports: state mismatch,
   5-minute timeout, port 53682 in use, Auth0 refusal.

Still manual after the script runs:

1. **Tenant-wide settings it will not touch**: enable WebAuthn roaming/platform (and OTP) under MFA; enable
   sign-up on the connection if it is disabled.
2. **Auth0 FGA store** and credentials (section 2).
3. **Postgres**, plus optional Hyperdrive if desired (section 3).
4. **Cloudflare**: copy `vars` into `wrangler.jsonc`, then `wrangler secret put` each name in `secrets` and
   `manualSecrets` (values for the `AUTHORITY_*` / `AGENT_*` ids and secrets are in the state file).

The numbered list below documents what the script configures, for review and for doing it by hand.

## 1. Auth0 tenant

1. **Task Authority API registration** (resource server for your custom backend)
   - Identifier (audience): your choice, e.g. `https://policy-desk.example/task-authority`
     -> Worker var `TASK_AUTHORITY_AUDIENCE`.
   - Signing algorithm RS256. RBAC on, "Add permissions in the access token" on
     (`token_dialect: access_token_authz`, `enforce_policies: true`).
   - Permissions (scopes): `delegations:create`, `delegations:read`, `operations:register`,
     `operations:read`, `operations:cancel`, `approvals:request`, `approvals:read`,
     `claims:create`, `outcomes:report`, `audit:read`, `usage:read`, `policies:write`,
     `policies:read`. Also `approvals:decide` as a user scope (read by `task-authority-approval.cjs`).
   - Rich Authorization Requests: authorization details type `task_authority_approval`.
     Reviewer PAR/RAR needs the Highly Regulated Identity entitlement; the template's routine tier works
     without it (session MFA + DPoP). The hosted sandbox makes every approval per-operation: the
     SPA signs in with email OTP and no `approvals:decide` scope (so no MFA at sign-in), and each approval is a fresh WebAuthn step-up bound to a service challenge by default (routine TOTP is an explicit sandbox opt-in; DPoP-bound rejection needs no new factor). High-value (`per_operation`) tiers need a token whose `amr`
     names `webauthn-platform` or `webauthn-roaming`, so enable WebAuthn as an MFA factor.
   - If the agent client requests a separate audience, create a second API and set `APP_AUDIENCE`;
     otherwise the agent also uses the Task Authority audience (the default).
2. **Organization** `policy-desk` (one shared organization, `organization_usage: allow`).
   - Enable a connection with sign-up (email OTP or social), "auto-membership" on, so visitors become
     members at first login. Worker var `AUTH0_ORG_ID` = its `org_...` id (enforced if set).
   - The shared organization does not leak data between visitors: each visitor's sandbox is a separate
     Task Authority tenant scope derived from their `sub`.
3. **SPA client** "Policy Desk" (renamed from "Policy Desk SPA"; Universal Login shows this name to visitors): app type SPA, Authorization Code + PKCE, `organization_usage: allow`,
   refresh token rotation on, DPoP ("sender-constrained tokens") enabled/required,
   callbacks/logout/web origins = your Worker origin. Grant it the Task Authority API with user access
   (no scopes needed; the SPA requests `approvals:decide` only on a decision step-up). Worker var `SPA_CLIENT_ID`.
4. **M2M clients** (client credentials, each granted only its permissions on the Task Authority API;
   store id and secret as Worker secrets):

   | Worker secrets                                                  | Permissions                                                                                                                                    |
   | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
   | `AUTHORITY_API_CLIENT_ID` / `_SECRET`                           | `delegations:create`, `delegations:read`, `operations:register`, `operations:read`, `operations:cancel`, `approvals:request`, `approvals:read` |
   | `AUTHORITY_EXECUTOR_CLIENT_ID` / `_SECRET`                      | `operations:read`, `claims:create`, `outcomes:report`                                                                                          |
   | `AUTHORITY_AUDITOR_CLIENT_ID` / `_SECRET`                       | `usage:read`, `audit:read`, `operations:read`, `delegations:read`, `approvals:read`                                                            |
   | `AUTHORITY_ADMIN_CLIENT_ID` / `_SECRET` (policy administration) | `policies:write`, `policies:read` only                                                                                                         |
   | `AGENT_CLIENT_ID` / `_SECRET` (the AI agent identity)           | none (grant it the audience in `APP_AUDIENCE`/Task Authority audience so it can obtain a token)                                                |
   | `EXTERNAL_AGENT_CLIENT_ID` / `_SECRET` (visitors' own agents)   | none (same audience grant); its tokens are handed out as sandbox agent keys and accepted only while bound (README, agent keys). Optional       |

   Optionally mark the agent client as an AI agent in the tenant so tokens carry agent claims
   (`sub_profile: ai_agent` / `act`); the sandbox treats any delegation-backed request as `actor.type = agent`.

5. **Delegating user "Alex"** (`policy-desk-alex`, created by `--create-alex`): a real Auth0 user, member of the
   `policy-desk` organization, who owns the agent's user-owned delegation. The Worker exchanges Alex's stored
   offline refresh token for an access token whenever it must (re)create the delegation, using the "Policy Desk
   Agent Owner" confidential client: Worker secrets `AGENT_OWNER_CLIENT_ID`, `AGENT_OWNER_CLIENT_SECRET`,
   `AGENT_OWNER_REFRESH_TOKEN` (the last one is set by `alex-login.mjs`). Rotation must stay off for that client.
   The default sandbox policy keeps Alex from reviewing the agent's request, so the visitor is a separate reviewer. The backend also supports an explicit `self_approval: "owner"` policy elsewhere; it is not enabled by this sandbox template.
6. **Actions** (Actions > Library, deploy, attach to Login flow in this order). Deploy the repo files
   unchanged; they are Auth0 Actions v3:
   1. `auth0/actions/task-authority-approval.cjs` (forces MFA/step-up for approval logins; add secret none)
   2. `auth0/actions/task-authority-assurance.cjs` (secret `TASK_AUTHORITY_AUDIENCE` = the API audience; writes
      namespaced `amr`, `auth_time`, decision jti claims). Worker var `AUTH0_CLAIM_NAMESPACE` must equal the
      `NS` constant in that file if you change it (default `https://task-authority.example/`).

7. **MFA**: enable the factors you want reviewers to use (OTP, WebAuthn roaming/platform). Without
   WebAuthn the high-value tier cannot be approved (by design; it is the PRD's phishing-resistant tier).
8. **Callback URLs**: `https://<your-origin>/` and `https://<your-origin>/review` (or whatever the UI uses)
   as Allowed Callback URLs. Allowed Web Origins should contain the origin only (no `/review` path); configure logout URLs separately. Also add the origin to CORS if the
   SPA calls the Worker cross-origin (it should not: same origin).

## 2. Auth0 FGA

1. Create an FGA store and write the model in `auth0/service/fga/model.fga`.
2. Credentials (two clients are cleaner; one is enough for a trial):
   - read/check: Worker secret `FGA_API_TOKEN` (or `FGA_CLIENT_ID`/`FGA_CLIENT_SECRET` client credentials)
   - write (sandbox setup/refresh): `FGA_ADMIN_TOKEN`, or the configured FGA client credentials with write access
3. Vars: `FGA_API_URL` (e.g. `https://api.us1.fga.dev`), `FGA_STORE_ID`, optional `FGA_MODEL_ID`,
   optional `FGA_TOKEN_URL` / `FGA_TOKEN_AUDIENCE` for Auth0 FGA client credentials.
4. The Worker writes, idempotently, on `organization:<org_id>`: the visitor (`member`, `refund_request`,
   `refund_approve`), Alex (`member`, `refund_request`), `agent:<AGENT_ID>` `registered_agent`, and the configured backend clients `trusted_backend`. Tuples for visitors accumulate in the store; prune them with a store-side job
   (the Worker's cleanup only deletes Postgres rows).

## 3. Cloudflare and Postgres

- A Postgres database (Supabase or another reachable Postgres 14+ host). Both checked-in Worker configs currently use the runtime role's `DATABASE_URL` secret directly. **Hyperdrive is optional**: add a binding named `HYPERDRIVE` with your configuration id to use it. Schemas: `authority` (custom approval backend) and `policy_desk` (demo).
- **Two database roles.** The Worker must not own the tables: an owner can disable the append-only
  triggers on `authority.audit_events` and `authority.policy_versions`. The restricted runtime role cannot do that directly, but can invoke demo cleanup; this is not tamper-proof or permanent audit storage.
  1. An **owner** role (the one that created the schemas) applies migrations and never goes into the Worker:
     `OWNER_DATABASE_URL=postgres://owner:...@host/db npx tsx demo/policy-desk/tools/migrate.ts`.
     This also grants the runtime role (`src/migrations/runtime-grants.sql`); re-run it after every
     migration.
  2. A **runtime** role, `policy_desk_runtime` (`create role policy_desk_runtime login password '...'`,
     as the owner or an admin), with DML only. It is the Worker's `DATABASE_URL` secret.
  3. `MIGRATE_ON_REQUEST` is `"false"` in `wrangler.jsonc`, so the Worker never runs DDL. TTL cleanup calls
     `policy_desk.wipe_tenants`, a `SECURITY DEFINER` function owned by the owner role that refuses any tenant
     that is not `pd_<24 hex>_g<n>`.

  Order for an existing deployment: create the runtime role, run `tools/migrate.ts` as the owner, set
  `DATABASE_URL` to the runtime role, then deploy.

- Build the UI (`npm run build:web`). For your own deployment use `npm run deploy` with the root config and `npm run setup`. The maintainer's `demo/policy-desk/wrangler.jsonc` attaches `mcp-tasks.dev` and its legacy redirect; do not use it as-is for another deployment.
- Worker vars: see `wrangler.jsonc` (`AUTH0_DOMAIN`, `TASK_AUTHORITY_AUDIENCE`, `SPA_CLIENT_ID`, `AUTH0_ORG_ID`,
  `AGENT_ID`, `HIGH_VALUE_QUORUM`, `FGA_API_URL`, `FGA_STORE_ID`).
- Worker secrets: `wrangler secret put <NAME>` for every secret above and the optional `IP_HASH_SALT`.
- Recommended in front: a Cloudflare WAF rate-limiting rule on `/sandbox/*` and `/v1/*` as a second layer.

## 4. Verification that needs a live tenant

Universal Login with the organization, MFA enrolment, DPoP at the token endpoint, the Actions' claims
(`amr` factor names, namespaced `auth_time`), WebAuthn for the high-value tier, the Alex refresh-token exchange, Auth0 FGA writes/checks, Hyperdrive, and the five-minute cleanup cron. Local tests use a stand-in IdP
(`auth0/tests/helpers/oidc-server.ts`, test only) and the Postgres tuple table (`ALLOW_LOCAL_FGA=1`, refused otherwise).
