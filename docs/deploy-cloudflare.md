# Deploy your own copy to Cloudflare

This guide takes you from nothing to a working MCP Tasks deployment in your own accounts: an AI agent requests refunds over MCP, Task Authority decides each one under your approval policy, and a person approves on the hosted page with real Auth0 MFA. Payments are simulated; everything else is real.

What gets deployed is one Cloudflare Worker (the root [`wrangler.jsonc`](../wrangler.jsonc)) that contains:

- the **Task Authority service** (`auth0/service`, imported, not copied) at `/v1/*`
- the **refund app**, with its MCP server at `/mcp` (MCP 2026-07-28 Tasks) and REST at `/v1/refunds`
- the **refund agent**, a real LLM on Workers AI that calls `/mcp` with its own Auth0 M2M token
- the **console and approval page** (the Policy Desk UI)

It is the same code that runs the hosted demo, with no custom domain and no tenant-specific values in the repo. `npm run setup` stores those as Worker secrets after the first deploy, so later redeploys from your repository never overwrite them.

Agents: [`AGENTS.md`](../AGENTS.md) has the same steps as a checklist.

> **Untested path.** As of 2026-11-02 nobody has run this guide end to end on a brand-new Auth0 tenant; the hosted demo's tenant was built up over time. Expect rough edges: `npm run setup -- --dry-run` shows the plan, `npm run verify` shows what is missing, and please [open an issue](https://github.com/bharath31/mcp-tasks/issues) with whatever breaks.

## 1. Prerequisites

| You need                    | Where                                                                                                                       | Notes                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A Cloudflare account        | <https://dash.cloudflare.com/sign-up>                                                                                       | Free plan is enough. Workers AI bills per use; the agent is rate limited to 20 turns per 10 minutes per user.                          |
| An Auth0 account and tenant | <https://auth0.com/signup>                                                                                                  | Use a **new, dedicated tenant**. Setup adds objects named `policy-desk` and turns on tenant-wide MFA factors and Universal Login text. |
| An Auth0 FGA store          | <https://dashboard.fga.dev>                                                                                                 | The free tier is enough. Sign in with the same Auth0 account.                                                                          |
| PostgreSQL 14+              | Any host the Worker can reach over TCP, for example [Supabase](https://supabase.com/dashboard) or [Neon](https://neon.tech) | You give setup the **owner** connection string once; the Worker gets its own DML-only role.                                            |
| Node 22, npm, git           | <https://nodejs.org>                                                                                                        |                                                                                                                                        |
| The Auth0 CLI               | `brew install auth0/auth0-cli/auth0`, or see [installation](https://github.com/auth0/auth0-cli#installation)                | Setup drives every Auth0 change through it.                                                                                            |
| A passkey-capable device    | Touch ID, Windows Hello, a phone or a security key                                                                          | High-value approvals need WebAuthn. OTP never satisfies them.                                                                          |

## 2. Deploy the Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bharath31/mcp-tasks)

The button copies this repository into your GitHub or GitLab account, connects it to Workers Builds, and deploys it. Keep the defaults it shows: build command `npm run build`, deploy command `npm run deploy`, Worker name `mcp-tasks`. It asks for no secrets; there are none to give yet. Every push to your copy redeploys.

When it finishes, note the Worker URL, for example `https://mcp-tasks.<your-subdomain>.workers.dev`. Until you run setup, `/healthz` and the API answer `503 dependency_unavailable` (no database yet); that is expected.

Prefer the terminal? Skip the button and run `npm run setup -- --deploy` in step 4. It runs `npm run build:web` and `wrangler deploy` with the same root config.

## 3. Create the FGA store client

In <https://dashboard.fga.dev>:

1. Create a store (or use the one the dashboard created for you).
2. Open **Settings**, then **Create Client**. Name it `mcp-tasks` and select **all** permission sets: the Worker reads and writes relationship tuples, and setup writes the authorization model.
3. Copy the **Store ID**, **Client ID** and **Client Secret** from the popup. The secret is shown once.

Setup writes [`auth0/service/fga/model.fga`](../auth0/service/fga/model.fga) to the store; you do not need to paste it.

## 4. Run setup

```sh
git clone https://github.com/<you>/mcp-tasks && cd mcp-tasks   # your copy, or this repository
npm ci
npm run setup
```

That is the whole step. Setup asks for anything it does not know yet:

| Question                  | Answer                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth0 tenant domain       | Defaults to the tenant the Auth0 CLI is logged in to, e.g. `you.us.auth0.com`.                                                               |
| Your Worker's URL         | From step 2, e.g. `https://mcp-tasks.<your-subdomain>.workers.dev`.                                                                          |
| Your email                | The address you sign in with; it also gets the `/admin` page. The demo's delegating user gets `you+alex@...` unless you pass `--alex-email`. |
| Postgres owner connection | The **owner** role (on Supabase, the `postgres` user). Used once to migrate; the Worker gets its own DML-only role. Hidden, never stored.    |
| FGA store ID, client ID   | From step 3.                                                                                                                                 |
| FGA client secret         | From step 3. Hidden, never stored.                                                                                                           |

It remembers the non-secret answers in `~/.policy-desk/setup.json`, so a re-run is just `npm run setup` again. If the Auth0 CLI or Wrangler is not logged in, or the Auth0 login lacks a scope setup needs, it opens that login for you (in `auth0 login`, choose **As a user** and pick your new tenant).

No terminal to answer questions (CI, a coding agent)? Pass everything and add `--yes`, which never asks and fails on anything missing:

```sh
export OWNER_DATABASE_URL='postgres://postgres:<password>@<host>:5432/postgres'
export FGA_STORE_ID='<store id>' FGA_CLIENT_ID='<client id>' FGA_CLIENT_SECRET='<client secret>'
# export FGA_API_URL=https://api.eu1.fga.dev   # only if your FGA store is not in the US region

npm run setup -- --yes \
  --tenant <your-tenant>.us.auth0.com \
  --origin https://mcp-tasks.<your-subdomain>.workers.dev \
  --admin-email <your sign-in email>
```

Without a terminal, setup cannot open logins, so log in first: `auth0 login --scopes "<the list setup prints>"` and `npx wrangler login`. `npm run doctor -- --deploy` checks both CLIs, the four variables and that the owner database answers, and changes nothing. Add `--dry-run` to print every Auth0 call before anything is written. `npm run setup -- --help` lists every flag.

What it does, in order:

| Step                     | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. CLIs                  | Checks that the Auth0 CLI is logged in to the tenant with the scopes setup needs, and that Wrangler is logged in. Opens either login when it can.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2. Auth0 tenant          | Enables the WebAuthn (roaming and platform) and authenticator-app (OTP) MFA factors, unless `--no-mfa`. Runs [`provision.mjs`](../demo/policy-desk/tools/provision.mjs): the Task Authority API (`<origin>/task-authority`, RBAC, permissions), the `policy-desk` organization, the "Policy Desk" app, five M2M clients (app, executor, auditor, policy admin, agent), the external-agent and Agent Owner clients, the two post-login Actions (deployed and appended to the login flow), and the delegating user Alex. Then creates the passwordless `email` connection the console signs in with and enables it for the app and the organization. |
| 3. Universal Login text  | Merges [`ul-text.mjs`](../demo/policy-desk/tools/ul-text.mjs) into the tenant's English custom text: sign-in and sign-up name the app, and the passkey and authenticator screens say what each code is for. Other keys you set are kept.                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4. Auth0 FGA             | Writes the authorization model unless the store's latest model already matches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5. Postgres              | Creates the `policy_desk_runtime` role (DML only, owns nothing), applies every migration as the owner, and grants the runtime role. The Worker never runs DDL (`MIGRATE_ON_REQUEST` is `"false"`), so it cannot disable the append-only audit triggers.                                                                                                                                                                                                                                                                                                                                                                                            |
| Deploy                   | Only with `--deploy`. Without `--origin`, it deploys first and reads the Worker URL from Wrangler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6. Worker secrets        | One `wrangler secret bulk` to the Worker named by `--worker` (default `mcp-tasks`): Auth0 domain, audience, app and organization ids, every client id and secret, the FGA values, the runtime role's `DATABASE_URL`, an `IP_HASH_SALT`, and `ADMIN_EMAILS`. Values go over stdin and are never printed.                                                                                                                                                                                                                                                                                                                                            |
| 7. Delegating user login | Opens your browser once. Sign in as Alex (the generated password is in `~/.policy-desk/auth0-state.json` under `alex.password`). The refresh token goes straight into the `AGENT_OWNER_REFRESH_TOKEN` secret. `--skip-alex-login` defers it.                                                                                                                                                                                                                                                                                                                                                                                                       |
| 8. Check                 | Read-only: the API, apps and callbacks, organization, email sign-in, Alex, MFA factors, that the deployed Actions match this repository's code and are bound in order, the Universal Login text, and the Worker's `/healthz`. Ends with "Auth0 is fully set up", or names each failed check and its fix. `npm run verify` runs only this step.                                                                                                                                                                                                                                                                                                     |

Client secrets and Alex's password are kept in `~/.policy-desk/auth0-state.json` (mode 0600, refused inside the repository). Keep that file; setup reuses it on re-runs.

Why Alex: the agent acts under a delegation from a real user, and Task Authority never lets the person who delegated (or initiated) an operation approve it. Alex is that delegating user, so you, signed in as yourself, are always a valid reviewer.

## 5. Your first approval

1. Open your Worker URL and choose **Sign in and start**. Sign in with your email; Auth0 sends a one-time code.
2. **Create my sandbox.** You get sample orders and the default refund policy, private to you and deleted after 15 minutes (reset any time).
3. In **Tell the agent**, send: `Sofia Alvarez's standing desk arrived cracked. Refund $1,500 of it.` The agent calls `request_refund` over MCP; the policy says refunds over $1,000 are high value, so the task waits for a person.
4. Under **Refunds waiting for a person**, open the refund, **Claim this refund**, read the operation, and approve. Auth0 asks for a fresh WebAuthn confirmation bound to this exact refund (enrol a passkey when prompted).
5. The agent's task resumes, redeems the approval once, and the simulated refund completes. **Show the audit timeline** shows every decision.

Then try a small refund (`Refund $40 to Mei Tanaka for the dead keyboard.`): the policy auto-allows agent refunds up to $100 within a daily budget, so no one is asked.

## 6. Change the policy

See [Write your first policy](approval-policy.md#write-your-first-policy): the console's **Policy** view, the offline `policy init|check|explain` loop, and where the deployed policy is defined.

## 7. Connect your own MCP client

`POST <origin>/mcp` speaks MCP `2026-07-28` with the Tasks extension (`io.modelcontextprotocol/tasks`): per-request `_meta`, no `initialize` handshake, and the bearer token is an Auth0 access token for `<origin>/task-authority`. Tools: `list_orders`, `get_order`, `request_refund` (task-augmented). Wire contract and examples: [`demo/policy-desk/API.md`](../demo/policy-desk/API.md).

Every request carries `_meta["io.modelcontextprotocol/protocolVersion"]: "2026-07-28"`; `request_refund` and `tasks/*` also need `_meta["io.modelcontextprotocol/clientCapabilities"]` to declare `extensions: { "io.modelcontextprotocol/tasks": {} }`. A client built for a 2025 revision opens with `initialize` and gets `-32022` (unsupported protocol version) listing `2026-07-28`, so it cannot connect. Claude Code 2.1.310 or later speaks `2026-07-28`; the stock 2025-revision MCP SDK clients do not. The Connect your agent panel in the console shows a working first call.

## Operating it

- **Admin page:** `<origin>/admin` for the `--admin-email` you set (visitors, approvals, model calls and tokens).
- **Redeploys:** push to your copy. Secrets survive deploys; re-run setup after pulling changes to `auth0/actions` or the Universal Login text (`npm run verify` says when), to rotate values, or after `--origin` changes (for example a custom domain: add it under the Worker's **Settings > Domains & Routes**, then re-run setup with the new `--origin` so Auth0 callbacks and the audience follow).
- **Health:** `<origin>/healthz`, or `npm run doctor -- --url <origin>`, which also explains a `503`.
- **Remove everything Auth0-side:** `node demo/policy-desk/tools/provision.mjs --tenant <t> --origin <o> --connection Username-Password-Authentication --destroy --apply`. Delete the Worker and the database separately.

## Troubleshooting

| Symptom                                                          | Cause and fix                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not sure where it fails                                          | `npm run verify` checks the tenant and the Worker; `npm run doctor -- --deploy --url <origin>` checks the prerequisites. Both print the fix for each miss.                                                                                                                                                                                                                            |
| `503` (`not_configured` or `dependency_unavailable`) after setup | A secret is missing or setup stopped early. Re-run setup; it resumes.                                                                                                                                                                                                                                                                                                                 |
| `wrangler secret bulk failed`                                    | The Worker is not deployed in the account Wrangler is logged in to, or `--worker` does not match its name.                                                                                                                                                                                                                                                                            |
| `insufficient_scope` from `auth0 api`                            | Re-run `npm run setup` on a terminal (it re-opens the Auth0 login), or run the `auth0 login --scopes ...` command setup prints.                                                                                                                                                                                                                                                       |
| `FGA token request failed (401)`                                 | Wrong client id or secret, or `FGA_API_URL` is not your store's region.                                                                                                                                                                                                                                                                                                               |
| Migration fails with `permission denied`                         | `OWNER_DATABASE_URL` is not the owner (on Supabase, use the `postgres` user).                                                                                                                                                                                                                                                                                                         |
| Approval page says WebAuthn is required                          | The high-value tier needs a passkey. Re-run setup without `--no-mfa`, or enable WebAuthn under **Security > Multi-factor Auth**.                                                                                                                                                                                                                                                      |
| Sign-in shows no email code option                               | The `email` connection is not enabled for the app or the organization. `npm run verify` shows which; re-run setup.                                                                                                                                                                                                                                                                    |
| `✗ Universal Login text`                                         | The tenant refused custom text (for example a Classic Universal Login tenant). Sign-in still works with Auth0's default copy. Switch the tenant to Universal Login under **Branding**, then re-run setup.                                                                                                                                                                             |
| Supabase pooled URL (`postgres.<ref>@…pooler…`)                  | Supported. Setup gives the Worker `policy_desk_runtime.<ref>`, the pooler's naming for custom roles.                                                                                                                                                                                                                                                                                  |
| Auth0 says "Callback URL mismatch" after **Approve**             | A build older than 31 Oct 2026 sent Auth0 back to `/review`. Deploy the current build, or re-run setup, which also registers `<origin>/review`.                                                                                                                                                                                                                                       |
| MCP clients get `403` "Just a moment…" on `POST /mcp`            | A Cloudflare managed challenge (Bot Fight Mode, Security Level, or a custom rule) runs in front of the Worker, and agents cannot solve it. In **Security > WAF > Custom rules**, add a **Skip** rule for `http.request.uri.path eq "/mcp"` that skips the remaining custom rules, Super Bot Fight Mode and Security Level. Bot Fight Mode (free plan) cannot be skipped: turn it off. |
| MCP client fails at connect with `-32022` on `initialize`        | The endpoint speaks MCP `2026-07-28` only (per-request `_meta`, no `initialize`). Use Claude Code 2.1.310 or later; see [Connect your own MCP client](#7-connect-your-own-mcp-client).                                                                                                                                                                                                |

## Honest limits

- The Worker code is what runs the hosted demo on the maintainer's tenant. The setup script is newer: it is covered by unit tests with a fake Auth0 CLI, Wrangler, FGA and database, and the root config was checked locally (bundle, owner-run migrations with the runtime role, `wrangler dev` serving the console, `/healthz` and `/mcp`), but it has not yet been run against a brand-new Auth0 tenant. Tenant features differ by plan: if your tenant rejects DPoP or RAR fields, `provision.mjs` continues without them and says so, and the routine tier (which requires DPoP) will not approve until DPoP is available.
- The deploy button requires this repository to be public.
- Visitor FGA tuples accumulate in your store; prune them with a store-side job if you run it for long.
