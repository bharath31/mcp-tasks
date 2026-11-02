// Cloudflare Worker entry. Migrations are bundled as text (see wrangler.jsonc rules).
import { createApp } from "./app.js";
import type { Env } from "./env.js";
import { legacyRedirect } from "./legacy-host.js";
import policyDesk0001 from "./migrations/0001_policy_desk.sql";
import policyDesk0002 from "./migrations/0002_dpop_replay.sql";
import policyDesk0003 from "./migrations/0003_runtime_role.sql";
import policyDesk0004 from "./migrations/0004_usage.sql";
import policyDesk0005 from "./migrations/0005_agent_conversations.sql";
import policyDesk0006 from "./migrations/0006_approval_ledger.sql";
import policyDesk0007 from "./migrations/0007_agent_keys.sql";
import authority0001 from "../../../auth0/service/migrations/0001_init.sql";
import authority0002 from "../../../auth0/service/migrations/0002_harden_roles.sql";
import authority0003 from "../../../auth0/service/migrations/0003_pin_function_search_path.sql";
import authority0004 from "../../../auth0/service/migrations/0004_ciba.sql";
import authority0005 from "../../../auth0/service/migrations/0005_policy.sql";
import authority0006 from "../../../auth0/service/migrations/0006_approval_policy.sql";
import authority0007 from "../../../auth0/service/migrations/0007_provider_events.sql";

// Names match the files the service's own Store.migrate() records, so a database
// migrated by either is recognised by the other.
const app = createApp({
  migrations: [
    { name: "0001_init.sql", sql: authority0001 },
    { name: "0002_harden_roles.sql", sql: authority0002 },
    { name: "0003_pin_function_search_path.sql", sql: authority0003 },
    { name: "0004_ciba.sql", sql: authority0004 },
    { name: "0005_policy.sql", sql: authority0005 },
    { name: "0006_approval_policy.sql", sql: authority0006 },
    { name: "0007_provider_events.sql", sql: authority0007 },
    { name: "policy-desk/0001_policy_desk.sql", sql: policyDesk0001 },
    { name: "policy-desk/0002_dpop_replay.sql", sql: policyDesk0002 },
    { name: "policy-desk/0003_runtime_role.sql", sql: policyDesk0003 },
    { name: "policy-desk/0004_usage.sql", sql: policyDesk0004 },
    { name: "policy-desk/0005_agent_conversations.sql", sql: policyDesk0005 },
    { name: "policy-desk/0006_approval_ledger.sql", sql: policyDesk0006 },
    { name: "policy-desk/0007_agent_keys.sql", sql: policyDesk0007 },
  ],
});

export default {
  fetch: (
    req: Request,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ) => legacyRedirect(req, env) ?? app.fetch(req, env, ctx),
  scheduled: (_event: unknown, env: Env) => app.scheduled(env),
};
