import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transformer } from "@openfga/syntax-transformer";
import { ACTIONS } from "./provision.mjs";
import {
  AUTH0_SCOPES,
  RUNTIME_ROLE,
  deployedOrigin,
  ensureFgaModel,
  gather,
  listedTenants,
  main,
  parseArgs,
  plusAddress,
  runtimeDatabaseUrl,
  sameModel,
  workerSecrets,
} from "./setup.mjs";

const ENV = {
  OWNER_DATABASE_URL: "postgres://postgres:ownpw@db.example.com:5432/postgres",
  FGA_STORE_ID: "01STORE",
  FGA_CLIENT_ID: "fga-client",
  FGA_CLIENT_SECRET: "fga-secret-value",
};
const ARGS = [
  "--tenant",
  "dev-x.us.auth0.com",
  "--origin",
  "https://mcp-tasks.dev.workers.dev",
  "--alex-email",
  "alex@example.com",
];
const DSL = readFileSync(
  new URL("../../../auth0/service/fga/model.fga", import.meta.url),
  "utf8",
);
const toJson = (dsl) => JSON.parse(transformer.transformDSLToJSON(dsl));

test("parseArgs requires tenant, origin, alex email and env secrets", () => {
  const o = parseArgs(ARGS, ENV, "/home/u");
  assert.equal(o.worker, "mcp-tasks");
  assert.equal(o.connection, "Username-Password-Authentication");
  assert.equal(o.fga.apiUrl, "https://api.us1.fga.dev");
  assert.equal(o.fga.tokenAudience, "https://api.us1.fga.dev/");
  assert.equal(o.state, "/home/u/.policy-desk/auth0-state.json");
  assert.throws(() => parseArgs(ARGS.slice(2), ENV), /--tenant is required/);
  assert.throws(
    () => parseArgs(ARGS, { ...ENV, FGA_STORE_ID: "" }),
    /FGA_STORE_ID/,
  );
  assert.throws(
    () =>
      parseArgs(
        [...ARGS.slice(0, 3), "https://x.dev/path", ...ARGS.slice(4)],
        ENV,
      ),
    /without a path/,
  );
  assert.throws(() => parseArgs([...ARGS, "--bogus"], ENV), /Unknown argument/);
  const eu = parseArgs(ARGS, {
    ...ENV,
    FGA_API_URL: "https://api.eu1.fga.dev/",
  });
  assert.equal(eu.fga.tokenAudience, "https://api.eu1.fga.dev/");
});

test("runtimeDatabaseUrl swaps in the runtime role and keeps a pooler suffix", () => {
  assert.equal(
    runtimeDatabaseUrl(ENV.OWNER_DATABASE_URL, "abc"),
    `postgres://${RUNTIME_ROLE}:abc@db.example.com:5432/postgres`,
  );
  assert.equal(
    runtimeDatabaseUrl(
      "postgresql://postgres.ref123:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require",
      "abc",
    ),
    `postgresql://${RUNTIME_ROLE}.ref123:abc@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`,
  );
  assert.throws(() => runtimeDatabaseUrl("mysql://a:b@c/d", "x"), /postgres/);
});

const STATE = {
  tenant: "dev-x.us.auth0.com",
  resourceServer: {
    identifier: "https://mcp-tasks.dev.workers.dev/task-authority",
  },
  organization: { id: "org_1" },
  alex: {
    user_id: "auth0|alex",
    email: "alex@example.com",
    password: "alex-pw",
  },
  actions: Object.fromEntries(
    ACTIONS.map((a, i) => [a.key, { id: `act_${i}`, name: a.name }]),
  ),
  clients: Object.fromEntries(
    [
      "spa",
      "api",
      "executor",
      "auditor",
      "admin",
      "agent",
      "externalAgent",
      "agentOwner",
    ].map((k) => [k, { client_id: `${k}-id`, client_secret: `${k}-secret` }]),
  ),
};

test("workerSecrets covers every deployment-specific value", () => {
  const o = parseArgs([...ARGS, "--admin-email", "me@example.com"], ENV);
  const s = workerSecrets({
    state: STATE,
    fga: o.fga,
    modelId: "01MODEL",
    databaseUrl: "postgres://r:p@h/db",
    o,
    salt: "salt",
  });
  for (const k of [
    "AUTH0_DOMAIN",
    "TASK_AUTHORITY_AUDIENCE",
    "SPA_CLIENT_ID",
    "AUTH0_ORG_ID",
    "AUTHORITY_API_CLIENT_SECRET",
    "AUTHORITY_EXECUTOR_CLIENT_ID",
    "AUTHORITY_AUDITOR_CLIENT_ID",
    "AUTHORITY_ADMIN_CLIENT_SECRET",
    "AGENT_CLIENT_ID",
    "EXTERNAL_AGENT_CLIENT_SECRET",
    "AGENT_OWNER_CLIENT_SECRET",
    "FGA_STORE_ID",
    "FGA_MODEL_ID",
    "FGA_CLIENT_SECRET",
    "DATABASE_URL",
    "IP_HASH_SALT",
    "ADMIN_EMAILS",
    "PUBLIC_URL",
  ])
    assert.ok(s[k], k);
  assert.equal(s.SPA_CLIENT_ID, "spa-id");
  // The Worker's root wrangler.jsonc must not also declare these as vars (deploy would fail).
  const config = readFileSync(
    new URL("../../../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  for (const k of Object.keys(s))
    assert.ok(!config.includes(`"${k}"`), `${k} in wrangler.jsonc`);
  // A state file from before external agents still works; the feature is just off.
  const old = structuredClone(STATE);
  delete old.clients.externalAgent;
  const oldSecrets = workerSecrets({
    state: old,
    fga: o.fga,
    modelId: "m",
    databaseUrl: "u",
    o,
    salt: "s",
  });
  assert.ok(!("EXTERNAL_AGENT_CLIENT_ID" in oldSecrets));
  const noAgent = structuredClone(STATE);
  delete noAgent.clients.agent;
  assert.throws(
    () =>
      workerSecrets({
        state: noAgent,
        fga: o.fga,
        modelId: "m",
        databaseUrl: "u",
        o,
        salt: "s",
      }),
    /AGENT_CLIENT_ID/,
  );
});

test("sameModel ignores ids and ordering", () => {
  const m = toJson(DSL);
  const shuffled = {
    id: "01OLD",
    ...m,
    type_definitions: [...m.type_definitions].reverse(),
  };
  assert.ok(sameModel(m, shuffled));
  assert.ok(
    !sameModel(m, { ...m, type_definitions: m.type_definitions.slice(1) }),
  );
});

function fakeFga(existing) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([init.method ?? "GET", String(url)]);
    const json = (b, status = 200) =>
      new Response(JSON.stringify(b), { status });
    if (String(url).endsWith("/oauth/token"))
      return json({ access_token: "tok", expires_in: 3600 });
    if (init.method === "POST")
      return json({ authorization_model_id: "01NEW" }, 201);
    return json({ authorization_models: existing ? [existing] : [] });
  };
  return { calls, fetchImpl };
}

test("ensureFgaModel writes once, then reuses the matching model", async () => {
  const o = parseArgs(ARGS, ENV);
  const fresh = fakeFga(null);
  assert.deepEqual(
    await ensureFgaModel(o.fga, {
      fetchImpl: fresh.fetchImpl,
      dsl: DSL,
      toJson,
    }),
    { id: "01NEW", written: true },
  );
  const same = fakeFga({ id: "01OLD", ...toJson(DSL) });
  assert.deepEqual(
    await ensureFgaModel(o.fga, {
      fetchImpl: same.fetchImpl,
      dsl: DSL,
      toJson,
    }),
    { id: "01OLD", written: false },
  );
  assert.ok(
    !same.calls.some(
      ([m, u]) => m === "POST" && u.includes("authorization-models"),
    ),
  );
});

/** An in-memory Auth0 tenant behind the `auth0 api` CLI shape, enough for setup and its checks. */
function fakeTenant({ origin = "https://mcp-tasks.dev.workers.dev" } = {}) {
  const factors = { otp: true };
  const connections = [
    { id: "con_db", name: "Username-Password-Authentication" },
  ];
  const enabledFor = {};
  const orgConnections = [];
  const text = {};
  const actionCode = Object.fromEntries(
    ACTIONS.map((a, i) => [
      `act_${i}`,
      readFileSync(new URL(`../../../${a.file}`, import.meta.url), "utf8"),
    ]),
  );
  return async (args) => {
    const [, method, path] = args;
    const body = args.includes("--data")
      ? JSON.parse(args[args.indexOf("--data") + 1])
      : undefined;
    const ok = (v) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
    const p = decodeURIComponent(path.split("?")[0]);
    if (method === "get" && p === "guardian/factors")
      return ok(
        Object.entries(factors).map(([name, enabled]) => ({ name, enabled })),
      );
    if (method === "put" && p.startsWith("guardian/factors/")) {
      factors[p.split("/")[2]] = true;
      return ok({ enabled: true });
    }
    if (method === "get" && p === "connections") {
      const name = new URLSearchParams(path.split("?")[1]).get("name");
      return ok(connections.filter((c) => c.name === name));
    }
    if (method === "post" && p === "connections") {
      const c = { id: "con_email", name: body.name };
      connections.push(c);
      return ok(c);
    }
    if (method === "patch" && /^connections\/[^/]+\/clients$/.test(p)) {
      enabledFor[p.split("/")[1]] = body.map((c) => c.client_id);
      return ok({});
    }
    if (method === "get" && /^connections\/[^/]+$/.test(p))
      return ok({ enabled_clients: enabledFor[p.split("/")[1]] ?? [] });
    if (p === "organizations/org_1/enabled_connections") {
      if (method === "post") orgConnections.push(body);
      return ok(orgConnections);
    }
    if (method === "get" && p === "organizations/org_1")
      return ok({ id: "org_1", name: "policy-desk" });
    if (method === "get" && p.startsWith("resource-servers/"))
      return ok({ identifier: p.slice("resource-servers/".length) });
    if (method === "get" && p.startsWith("clients/"))
      return ok({
        client_id: p.slice(8),
        name: "Policy Desk",
        callbacks: [origin, `${origin}/`, `${origin}/review`],
      });
    if (method === "get" && p === "users/auth0|alex")
      return ok({ user_id: "auth0|alex" });
    if (method === "get" && p.startsWith("actions/actions/"))
      return ok({
        code: actionCode[p.split("/")[2]],
        all_changes_deployed: true,
      });
    if (method === "get" && p === "actions/triggers/post-login/bindings")
      return ok({
        bindings: ACTIONS.map((a) => ({ action: { name: a.name } })),
      });
    if (p.startsWith("prompts/")) {
      if (method === "put") text[p] = body;
      return ok(text[p] ?? {});
    }
    return ok({});
  };
}

function harness({
  provisionCode = 0,
  tenantsOut = "dev-x.us.auth0.com",
} = {}) {
  const out = [];
  const execs = [];
  const auth0 = [];
  const queries = [];
  const saved = [];
  const tenant = fakeTenant();
  const deps = {
    home: "/home/test",
    prompt: undefined,
    loadConfig: () => ({}),
    saveConfig: (c) => saved.push(c),
    auth0Scopes: () => null,
    out: (l) => out.push(l),
    err: (l) => out.push(l),
    exec: async (cmd, args, opts = {}) => {
      execs.push({ cmd, args, input: opts.input, env: opts.env, opts });
      if (cmd === "auth0") return { code: 0, stdout: tenantsOut, stderr: "" };
      if (args[1] === "whoami")
        return { code: 0, stdout: "You are logged in", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    run: async (args) => {
      auth0.push(args);
      return tenant(args);
    },
    provision: async () => provisionCode,
    alexLogin: async (_argv, d) =>
      (await d.putSecret("refresh-token-value")).code,
    pg: async () => ({
      Client: class {
        async connect() {}
        async query(sql, params) {
          queries.push([sql, params]);
          return { rowCount: 0, rows: [] };
        }
        async end() {}
      },
    }),
    toJson: async () => toJson,
    readState: () => STATE,
    fetchImpl: fakeFga(null).fetchImpl,
    random: (n) => "ab".repeat(n),
  };
  return { out, execs, auth0, queries, saved, deps };
}

test("main runs every step and never prints a secret", async () => {
  const h = harness();
  const code = await main([...ARGS, "--enable-mfa"], h.deps, ENV);
  assert.equal(code, 0, h.out.join("\n"));
  const text = h.out.join("\n");
  for (const secret of [
    "fga-secret-value",
    "ownpw",
    "api-secret",
    "alex-pw",
    "abab",
  ])
    assert.ok(!text.includes(secret), `printed ${secret}`);
  // MFA: otp was already on, both WebAuthn factors get enabled.
  const puts = h.auth0
    .filter((a) => a[1] === "put" && a[2].startsWith("guardian"))
    .map((a) => a[2]);
  assert.deepEqual(puts, [
    "guardian/factors/webauthn-roaming",
    "guardian/factors/webauthn-platform",
  ]);
  // Email connection created and enabled for the SPA and the organization.
  assert.ok(h.auth0.some((a) => a[1] === "post" && a[2] === "connections"));
  assert.ok(
    h.auth0.some(
      (a) =>
        a[1] === "post" && a[2] === "organizations/org_1/enabled_connections",
    ),
  );
  // Runtime role created before migrating as the owner.
  assert.match(
    h.queries[1][0],
    /^create role policy_desk_runtime with login password '[a-f0-9]+'$/,
  );
  const migrate = h.execs.find((e) =>
    e.args?.includes("demo/policy-desk/tools/migrate.ts"),
  );
  assert.equal(migrate.env.OWNER_DATABASE_URL, ENV.OWNER_DATABASE_URL);
  // Secrets go over stdin to the named Worker, with the runtime role's URL.
  const bulk = h.execs.find((e) => e.args.includes("bulk"));
  assert.deepEqual(bulk.args.slice(-2), ["--name", "mcp-tasks"]);
  const secrets = JSON.parse(bulk.input);
  assert.match(secrets.DATABASE_URL, /^postgres:\/\/policy_desk_runtime:/);
  assert.equal(secrets.FGA_MODEL_ID, "01NEW");
  const refresh = h.execs.find((e) =>
    e.args.includes("AGENT_OWNER_REFRESH_TOKEN"),
  );
  assert.equal(refresh.input, "refresh-token-value");
  // Universal Login text written, then every read-only check passes.
  assert.ok(h.auth0.some((a) => a[1] === "put" && a[2].startsWith("prompts/")));
  assert.match(text, /✓ Auth0 is fully set up on dev-x\.us\.auth0\.com/);
  assert.doesNotMatch(text, /✗/);
  // Non-secret answers are remembered for the next run; secrets are not.
  assert.equal(h.saved[0].tenant, "dev-x.us.auth0.com");
  assert.ok(!JSON.stringify(h.saved).includes("fga-secret-value"));
  assert.ok(!JSON.stringify(h.saved).includes("ownpw"));
});

test("MFA factors are on by default; --no-mfa leaves them alone", async () => {
  const on = harness();
  assert.equal(await main(ARGS, on.deps, ENV), 0, on.out.join("\n"));
  assert.ok(
    on.auth0.some((a) => a[1] === "put" && a[2].startsWith("guardian")),
  );
  const off = harness();
  await main([...ARGS, "--no-mfa"], off.deps, ENV);
  assert.ok(
    !off.auth0.some((a) => a[1] === "put" && a[2].startsWith("guardian")),
  );
});

test("--verify only reads, needs no secrets, and names what is missing", async () => {
  const h = harness();
  const env = {};
  const code = await main([...ARGS.slice(0, 4), "--verify"], h.deps, env);
  // A fresh fake tenant has no email connection, factors or text yet.
  assert.equal(code, 1);
  assert.ok(h.auth0.every((a) => a[1] === "get"));
  const text = h.out.join("\n");
  assert.match(text, /✗ Passwordless "email" sign-in/);
  assert.match(
    text,
    /✗ MFA factors.*not enabled: webauthn-roaming, webauthn-platform/,
  );
  assert.match(text, /✗ Auth0 is not fully set up/);
  assert.match(text, /✓ Task Authority API/);
});

test("without a terminal, a missing login fails with the exact command", async () => {
  const h = harness();
  h.deps.exec = async (cmd) =>
    cmd === "auth0"
      ? { code: 1, stdout: "", stderr: "not logged in" }
      : { code: 0, stdout: "", stderr: "" };
  assert.equal(await main(ARGS, h.deps, ENV), 1);
  const text = h.out.join("\n");
  assert.match(text, /auth0 login --scopes "read:client_grants,/);
  assert.match(text, /read:prompts,update:prompts/);
});

test("on a terminal, setup logs the Auth0 CLI in again when scopes are missing", async () => {
  const h = harness();
  h.deps.prompt = async () => "";
  h.deps.auth0Scopes = () => ["read:clients"];
  assert.equal(await main(ARGS, h.deps, ENV), 0, h.out.join("\n"));
  const login = h.execs.find((e) => e.cmd === "auth0" && e.args[0] === "login");
  assert.ok(login, "ran auth0 login");
  assert.equal(login.opts.interactive, true);
  assert.equal(login.args[2], AUTH0_SCOPES.join(","));
});

test("gather asks only for what is missing and reuses remembered answers", async () => {
  const asked = [];
  const answers = {
    "Your Worker's URL": "https://mcp-tasks.me.workers.dev",
    "Your email": "me@example.com",
    "Postgres owner": "postgres://postgres:pw@h/db",
    "Auth0 FGA client secret": "s3cret",
  };
  const prompt = async (q, opts) => {
    asked.push([q, opts]);
    const k = Object.keys(answers).find((a) => q.startsWith(a));
    return k ? answers[k] : (opts?.fallback ?? "");
  };
  const { args, env } = await gather(
    [],
    {},
    {
      prompt,
      loadConfig: () => ({ fgaStoreId: "01S", fgaClientId: "cid" }),
    },
    { tenants: ["me.eu.auth0.com"] },
  );
  const o = parseArgs(args, env, "/h");
  assert.equal(o.tenant, "me.eu.auth0.com");
  assert.equal(o.origin, "https://mcp-tasks.me.workers.dev");
  assert.equal(o.alexEmail, "me+alex@example.com");
  assert.equal(o.fga.storeId, "01S");
  assert.ok(!asked.some(([q]) => q.startsWith("Auth0 FGA store")));
  assert.equal(asked.find(([q]) => q.startsWith("Postgres"))[1].secret, true);
  // --yes never asks.
  const none = [];
  await gather(["--yes"], {}, { prompt: async (q) => none.push(q) });
  assert.equal(none.length, 0);
});

test("helpers: plus addresses, tenant lists and deploy URLs", () => {
  assert.equal(plusAddress("me@example.com"), "me+alex@example.com");
  assert.equal(plusAddress("me+x@example.com"), "me+alex@example.com");
  assert.deepEqual(
    listedTenants(
      "  ACTIVE   a-1.us.auth0.com\n  b.eu.auth0.com\n a-1.us.auth0.com",
    ),
    ["a-1.us.auth0.com", "b.eu.auth0.com"],
  );
  assert.equal(
    deployedOrigin("Uploaded mcp-tasks\n  https://mcp-tasks.me.workers.dev\n"),
    "https://mcp-tasks.me.workers.dev",
  );
  assert.equal(deployedOrigin("nothing"), undefined);
});

test("main --dry-run stops after the Auth0 plan", async () => {
  const h = harness();
  assert.equal(await main([...ARGS, "--dry-run"], h.deps, ENV), 0);
  assert.ok(!h.execs.some((e) => e.args.includes("bulk")));
  assert.equal(h.queries.length, 0);
  assert.ok(!h.auth0.some((a) => a[1] !== "get"));
});

test("main stops when provisioning fails", async () => {
  const h = harness({ provisionCode: 1 });
  assert.equal(await main(ARGS, h.deps, ENV), 1);
  assert.ok(h.out.some((l) => l.includes("Auth0 provisioning failed")));
  assert.ok(!h.execs.some((e) => e.args.includes("bulk")));
});
