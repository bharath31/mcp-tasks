# Refund Workflow

A refund agent as a [Cloudflare Workflow](https://developers.cloudflare.com/workflows/), gated by `approve()` from `@task-authority/sdk/approve`. The workflow pauses on the engine's own `step.waitForEvent`; `approve()` decides whether the event that resumes it is a real decision: a fresh passkey sign-in at Auth0, by someone with the `finance` role, for exactly this refund, run and step.

There is no custom Task Authority backend, FGA store or application Postgres database in this example. Cloudflare Workflows persists the run; a KV namespace stores its review link. `approve()` is this repo's experimental SDK code, not an Auth0 product. The proof is the ID token Auth0 signs, checked inside the workflow against the tenant's public keys. The refund itself is a stand-in keyed by the approval's idempotency key, as a Stripe call would be.

How it works and what it guarantees: [docs/approve.md](../../docs/approve.md).

## Run it

You need a dedicated Auth0 tenant with the required passkey feature and a Cloudflare account. Check tenant entitlements rather than assuming a particular plan. Run these commands from the repository root after `npm ci`. This example exposes demo run/status/forgery endpoints without production access controls; do not attach real payment credentials.

1. **Initialize Auth0.** Log in the Auth0 CLI with Management API scopes, then run:

   ```sh
   auth0 login --scopes "read:clients,create:clients,update:clients,read:connections,update:connections,read:roles,create:roles,read:actions,create:actions,update:actions"
   npm run task-authority -- approve init \
     --tenant <your-tenant>.us.auth0.com \
     --app-url https://<worker-name>.<your-subdomain>.workers.dev \
     --role finance
   ```

   `init` creates the Regular Web App, enables passkeys on the selected database connection, deploys and binds the approval Action without removing other Login Actions, creates the role, and writes `.dev.vars`. Assign the `finance` role to the approvers in Auth0. Add `--dry-run` to preview the changes, or `--wrangler` to print `wrangler secret put` commands instead of writing `.dev.vars`.

2. **Deploy the Worker.** Create a KV namespace and put its id in `wrangler.jsonc`, then deploy:

   ```sh
   npx wrangler kv namespace create LINKS --config demo/refund-workflow/wrangler.jsonc
   # Put the returned ID in demo/refund-workflow/wrangler.jsonc.
   # Also replace AUTH0_DOMAIN, AUTH0_CLIENT_ID and APP_URL in that config.
   npx wrangler secret put AUTH0_CLIENT_SECRET --config demo/refund-workflow/wrangler.jsonc
   npm run deploy -w @task-authority/refund-workflow
   ```

   `.dev.vars` is for local development and is **not uploaded by deploy**. Enter the application secret privately at the Wrangler prompt; do not paste it into commands or commits. If you selected email OTP or push, configure the additional values emitted by `approve init` on the deployed Worker too. `--wrangler` only prints secret-command names; it does not execute them.

For local development, set `--app-url http://localhost:8787` and run `npm run dev -w @task-authority/refund-workflow`. Open `APP_URL`, start a refund, press **Send a forged approval** (the run keeps waiting), then **Open approval page** and approve with your passkey.

## Tests

`auth0/tests/integration/approve-cloudflare.test.ts` runs this Worker in workerd under Miniflare with a real Workflow, against the local OIDC provider over TLS. It covers: forged events refused while the run keeps waiting, a wrong approver refused, a real proof replayed at another run refused, a rejection ending the run without a refund, and an approval completing it once.

Not yet run against a live Auth0 tenant. See "Verified so far" in [docs/approve.md](../../docs/approve.md).
