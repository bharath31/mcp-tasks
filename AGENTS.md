# Instructions for coding agents

This repository is a reference implementation of MCP Tasks gated by Auth0 approvals. Read [README.md](README.md) and [docs/architecture.md](docs/architecture.md) for what it is. This file tells you how to deploy it for a user and how to work on it.

## Deploy a working copy for a user

Follow [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md). Condensed:

1. Confirm the user has: a Cloudflare account, an Auth0 account with a **new** tenant (<https://auth0.com/signup>), an Auth0 FGA store (<https://dashboard.fga.dev>), and a Postgres owner connection string. You cannot create these accounts for them; ask once, for all of them together.
2. Ask the user to create the FGA client (dashboard **Settings > Create Client**, all permission sets) and give you the Store ID, Client ID and Client Secret. Treat the secret like a password: pass it through the environment, never in a command line, a file in the repo, or a message you echo back.
3. Deploy the Worker: either the user clicks the **Deploy to Cloudflare** button in the README, or you add `--deploy` in step 5 (then `--origin` can be omitted; setup reads the URL from Wrangler).
4. Make sure the CLIs are installed and logged in. On a terminal the user can answer, plain `npm run setup` opens the Auth0 and Wrangler logins itself. Without one, the user runs `auth0 login --scopes "<list>"` (setup prints the exact list when it is missing a scope) and `npx wrangler login`. Check with `npm run doctor -- --deploy`, which also confirms the setup variables are set and the owner database answers (it never prints their values).
5. Run setup with secrets in the environment and `--yes`, so it never waits on a question:

   ```sh
   OWNER_DATABASE_URL=... FGA_STORE_ID=... FGA_CLIENT_ID=... FGA_CLIENT_SECRET=... \
   npm run setup -- --yes --tenant <tenant domain> --origin <Worker https origin> \
     --admin-email <user's email> [--deploy]
   ```

   Run it with `--dry-run` first if the tenant is not brand new, and show the user the plan. The delegating user defaults to the user's `+alex` address; override with `--alex-email`. Step 7 opens a browser for that user's one-time sign-in; the user must complete it (password in `~/.policy-desk/auth0-state.json`, `alex.password`). If they cannot right now, pass `--skip-alex-login` and re-run setup without it later (every other step is skipped or repeated harmlessly).

6. Verify: setup ends with a read-only checklist and "Auth0 is fully set up". `npm run verify` repeats it any time. Then walk the user through "Your first approval" in the guide. Approvals need the user's own passkey; you cannot approve on their behalf, by design.

Setup is idempotent. On failure, read the error, fix the cause (the troubleshooting table in the guide covers the common ones), and re-run the same command.

## Write or change an approval policy

Use the offline loop; it needs no server:

```sh
npm run task-authority -- policy init refunds > refunds.json
npm run task-authority -- policy check refunds.json
npm run task-authority -- policy explain refunds.json refund:create --actor agent --args '{"amountMinor":5000,"currency":"usd"}'
```

`check` runs the same validation as publishing. Use `explain` to show the user the decision for each example they care about before publishing. Reference: [docs/approval-policy.md](docs/approval-policy.md).

## Working on the code

- `npm ci`, `npm run db:up` (Postgres in Docker on `127.0.0.1:55432`, or set `TEST_PG_ADMIN_URL`), then `npm run check` before every push: it is what CI runs. `npm run doctor` explains a failing prerequisite.
- To try a change end to end with a real MCP host, `npm run local -- --owner` and Claude Code ([docs/claude-code.md](docs/claude-code.md)).
- Where things live: [docs/README.md](docs/README.md).
- Layers: `auth0/service` (Task Authority), `auth0/sdk` (client), `demo/*` (customer apps). `node auth0/tools/check-boundaries.mjs` enforces that demo apps use only the SDK.
- The root `wrangler.jsonc` is the one-click deployment. `demo/policy-desk/wrangler.jsonc` is the maintainer's hosted demo (custom domain); do not point a user's deploy at it.
- Never commit secrets. `.dev.vars*` and `.env*` are ignored; the lint step scans tracked files.
