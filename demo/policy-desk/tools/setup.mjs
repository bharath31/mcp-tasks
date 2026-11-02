#!/usr/bin/env node
// One command from "I have accounts" to "it works": logs the Auth0 CLI and Wrangler in if needed,
// configures your Auth0 tenant end to end (API, apps, organization, passwordless email sign-in, MFA
// factors, post-login Actions, Universal Login text, the delegating user), writes the FGA model,
// migrates Postgres, stores every value the Worker needs as a Worker secret, and finishes with a
// read-only check that ends in "Auth0 is fully set up". Safe to re-run: every step looks up what
// exists first, and answers are remembered in ~/.policy-desk/setup.json (never secrets).
//
//   npm run setup                      # asks for anything it needs
//   npm run setup -- --verify          # only the read-only checks
//   npm run setup -- --tenant <you>.us.auth0.com --origin https://mcp-tasks.<you>.workers.dev \
//     --admin-email <you@example.com> --yes        # no questions (CI, agents); secrets from env
//
// Full guide: docs/deploy-cloudflare.md. Secrets come from the environment or a hidden prompt, never
// argv, and are never printed. Use a dedicated tenant: MFA factors and Universal Login text are
// tenant-wide (--no-mfa leaves the factors alone).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ProvisionError,
  main as provisionMain,
  makeScrubber,
  parseCliError,
  parseCliJson,
  realRunner,
  secretValuesFromState,
} from "./provision.mjs";
import { applyUlText } from "./ul-text.mjs";
import {
  EMAIL_CONNECTION,
  MFA_FACTORS,
  report,
  verifyAuth0,
} from "./verify-auth0.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../..");
export const RUNTIME_ROLE = "policy_desk_runtime";
export { EMAIL_CONNECTION, MFA_FACTORS };
export const DEFAULT_FGA_API_URL = "https://api.us1.fga.dev";
export const DEFAULT_FGA_TOKEN_URL = "https://auth.fga.dev/oauth/token";

export class SetupError extends Error {}

const USAGE = `Usage: npm run setup [-- options]

With no options it asks for what it needs and remembers the answers.

  --tenant <domain>        Auth0 tenant, e.g. you.us.auth0.com (default: the Auth0 CLI's tenant)
  --origin <https origin>  The Worker's URL, e.g. https://mcp-tasks.you.workers.dev
  --admin-email <email>    Your sign-in email; gets the /admin page
  --alex-email <email>     Email for the demo's delegating user (default: you+alex@...)
  --worker <name>          Worker name (default mcp-tasks)
  --deploy                 Build and deploy the Worker first (instead of the Deploy button)
  --no-mfa                 Leave the tenant's MFA factors alone
  --verify                 Only run the read-only checks
  --dry-run                Print the Auth0 plan and stop
  --yes                    Never ask; fail on anything missing
  --skip-alex-login, --connection <name>, --state <path>

Environment (asked for when missing): OWNER_DATABASE_URL, FGA_STORE_ID, FGA_CLIENT_ID,
FGA_CLIENT_SECRET (optional FGA_API_URL, FGA_TOKEN_URL, FGA_TOKEN_AUDIENCE).
Guide: docs/deploy-cloudflare.md`;

/** Management API scopes setup needs beyond the Auth0 CLI's defaults. Asking for one twice is harmless. */
export const AUTH0_SCOPES = [
  "read:client_grants",
  "create:client_grants",
  "update:client_grants",
  "read:organizations",
  "create:organizations",
  "update:organizations",
  "read:organization_connections",
  "create:organization_connections",
  "update:organization_connections",
  "create:organization_members",
  "read:organization_members",
  "read:connections",
  "create:connections",
  "update:connections",
  "read:users",
  "create:users",
  "update:users",
  "read:guardian_factors",
  "update:guardian_factors",
  "read:prompts",
  "update:prompts",
];
export const AUTH0_LOGIN = ["login", "--scopes", AUTH0_SCOPES.join(",")];

/** Non-secret answers kept between runs. */
export const REMEMBERED = {
  tenant: "--tenant",
  origin: "--origin",
  adminEmail: "--admin-email",
  alexEmail: "--alex-email",
  worker: "--worker",
};

export function parseArgs(argv, env = process.env, home = homedir()) {
  const valued = new Set([
    "--tenant",
    "--origin",
    "--alex-email",
    "--worker",
    "--connection",
    "--admin-email",
    "--state",
  ]);
  const flags = new Set([
    "--enable-mfa",
    "--deploy",
    "--skip-alex-login",
    "--dry-run",
    "--no-mfa",
    "--verify",
    "--yes",
    "--help",
  ]);
  const o = {
    worker: "mcp-tasks",
    connection: "Username-Password-Authentication",
    state: join(home, ".policy-desk", "auth0-state.json"),
    varsOut: join(home, ".policy-desk", "wrangler-vars.json"),
  };
  const camel = (a) =>
    a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] === "-h" ? "--help" : argv[i];
    if (flags.has(a)) o[camel(a)] = true;
    else if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--"))
        throw new SetupError(`${a} needs a value`);
      o[camel(a)] = v;
    } else throw new SetupError(`Unknown argument: ${a}`);
  }
  if (o.help) return o;
  // MFA factors are on by default: high-value approvals need a passkey. --enable-mfa is the old spelling.
  o.mfa = !o.noMfa;
  if (
    !o.alexEmail &&
    o.adminEmail &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.adminEmail)
  )
    o.alexEmail = plusAddress(o.adminEmail);
  for (const k of o.verify
    ? ["tenant", "origin"]
    : ["tenant", "origin", "alexEmail"])
    if (!o[k])
      throw new SetupError(
        `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`,
      );
  let u;
  try {
    u = new URL(o.origin);
  } catch {
    throw new SetupError(`--origin is not a URL: ${o.origin}`);
  }
  if (u.protocol !== "https:" || u.pathname !== "/" || u.search || u.hash)
    throw new SetupError(
      "--origin must be the Worker's https origin without a path, e.g. https://mcp-tasks.you.workers.dev",
    );
  o.origin = u.origin;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.worker))
    throw new SetupError(
      "--worker must be a Worker name (lowercase, digits, -)",
    );
  if (o.adminEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.adminEmail))
    throw new SetupError("--admin-email needs an email address");
  o.state = resolve(o.state.replace(/^~(?=$|\/)/, home));
  if (o.verify) return o;
  const need = (k) => {
    if (!env[k]) throw new SetupError(`Set ${k} in the environment.`);
    return env[k];
  };
  o.databaseUrl = need("OWNER_DATABASE_URL");
  const apiUrl = (env.FGA_API_URL || DEFAULT_FGA_API_URL).replace(/\/$/, "");
  o.fga = {
    apiUrl,
    storeId: need("FGA_STORE_ID"),
    clientId: need("FGA_CLIENT_ID"),
    clientSecret: need("FGA_CLIENT_SECRET"),
    tokenUrl: env.FGA_TOKEN_URL || DEFAULT_FGA_TOKEN_URL,
    tokenAudience: env.FGA_TOKEN_AUDIENCE || `${apiUrl}/`,
  };
  return o;
}

/** you@example.com -> you+alex@example.com: a second identity that lands in your own inbox. */
export function plusAddress(email) {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at).split("+")[0];
  return `${local}+alex${email.slice(at)}`;
}

/**
 * The Worker's connection string: the owner's URL with the DML-only runtime role swapped in. Pooled
 * Supabase URLs name the user `<role>.<project-ref>`, so that suffix is kept.
 */
export function runtimeDatabaseUrl(ownerUrl, password) {
  const u = new URL(ownerUrl);
  if (!/^postgres(ql)?:$/.test(u.protocol))
    throw new SetupError("OWNER_DATABASE_URL must be a postgres:// URL");
  const user = decodeURIComponent(u.username);
  const dot = user.indexOf(".");
  u.username = dot > 0 ? `${RUNTIME_ROLE}${user.slice(dot)}` : RUNTIME_ROLE;
  u.password = password;
  return u.toString();
}

/** Every value the Worker reads that is specific to this deployment, as one secret map. */
export function workerSecrets({ state, fga, modelId, databaseUrl, o, salt }) {
  const clients = secretValuesFromState(state);
  // Optional: without it the Worker only disables "Connect your agent". Older state files lack it.
  if (
    !clients.EXTERNAL_AGENT_CLIENT_ID ||
    !clients.EXTERNAL_AGENT_CLIENT_SECRET
  ) {
    delete clients.EXTERNAL_AGENT_CLIENT_ID;
    delete clients.EXTERNAL_AGENT_CLIENT_SECRET;
  }
  const missing = Object.entries(clients)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length)
    throw new SetupError(
      `The Auth0 state file lacks ${missing.join(", ")}. Re-run without --dry-run.`,
    );
  const out = {
    PUBLIC_URL: o.origin,
    AUTH0_DOMAIN: state.tenant,
    TASK_AUTHORITY_AUDIENCE: state.resourceServer?.identifier,
    SPA_CLIENT_ID: state.clients?.spa?.client_id,
    AUTH0_ORG_ID: state.organization?.id,
    ...clients,
    FGA_API_URL: fga.apiUrl,
    FGA_STORE_ID: fga.storeId,
    FGA_MODEL_ID: modelId,
    FGA_CLIENT_ID: fga.clientId,
    FGA_CLIENT_SECRET: fga.clientSecret,
    FGA_TOKEN_URL: fga.tokenUrl,
    FGA_TOKEN_AUDIENCE: fga.tokenAudience,
    DATABASE_URL: databaseUrl,
    IP_HASH_SALT: salt,
    ...(o.adminEmail ? { ADMIN_EMAILS: o.adminEmail } : {}),
  };
  const empty = Object.entries(out)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (empty.length) throw new SetupError(`No value for ${empty.join(", ")}.`);
  return out;
}

/** Same type definitions and conditions, ignoring ids and key order. */
export function sameModel(a, b) {
  const norm = (m) =>
    JSON.stringify(
      [...(m?.type_definitions ?? [])]
        .map((t) => sortKeys(t))
        .sort((x, y) => x.type.localeCompare(y.type)),
    ) + JSON.stringify(sortKeys(m?.conditions ?? {}));
  return norm(a) === norm(b);
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    );
  return v;
}

/** Plain `auth0 api` calls for the two tenant objects provision.mjs deliberately does not touch. */
function auth0Api(run, tenant, scrubber) {
  return async (method, path, body) => {
    const args = ["api", method.toLowerCase(), path, "--tenant", tenant];
    args.push("--no-input");
    if (body !== undefined) args.push("--data", JSON.stringify(body));
    const r = await run(args);
    if (r.code === 0) return parseCliJson(r.stdout);
    const e = parseCliError(r.stderr);
    const err = new SetupError(
      scrubber.scrub(
        `auth0 api ${method} ${path.split("?")[0]} failed${e.status ? ` (${e.status})` : ""}: ${e.message}`,
      ),
    );
    err.status = e.status;
    throw err;
  };
}

/** Turns on the MFA factors approvals use. Tenant-wide, so only with --enable-mfa. */
export async function enableMfa(api, say, dryRun) {
  const factors = (await api("GET", "guardian/factors")) ?? [];
  for (const name of MFA_FACTORS) {
    if (factors.find((f) => f.name === name)?.enabled) {
      say(`SKIP MFA factor ${name} already enabled`);
      continue;
    }
    if (!dryRun)
      await api("PUT", `guardian/factors/${name}`, { enabled: true });
    say(`${dryRun ? "PLAN" : "DO  "} enable MFA factor ${name}`);
  }
}

async function findConnection(api, name) {
  const list =
    (await api(
      "GET",
      `connections?name=${encodeURIComponent(name)}&fields=id,name,strategy&include_fields=true`,
    )) ?? [];
  return (Array.isArray(list) ? list : (list.connections ?? [])).find(
    (c) => c.name === name,
  );
}

/** Enables a connection for one application, with the current endpoint and the legacy fallback. */
async function enableForClient(api, conn, clientId) {
  try {
    await api("PATCH", `connections/${conn.id}/clients`, [
      { client_id: clientId, status: true },
    ]);
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
    const full = await api("GET", `connections/${conn.id}`);
    const current = full?.enabled_clients ?? [];
    if (current.includes(clientId)) return;
    await api("PATCH", `connections/${conn.id}`, {
      enabled_clients: [...current, clientId],
    });
  }
}

/**
 * The console signs visitors in with passwordless email OTP, so the tenant needs an `email`
 * connection enabled for the SPA and the organization (auto-membership). The delegating user signs in
 * through the database connection, which must be enabled for the Agent Owner client.
 */
export async function ensureLoginConnections(api, state, o, say) {
  if (o.dryRun) {
    say(
      `PLAN ensure connection "${EMAIL_CONNECTION}" for the SPA and organization, and "${o.connection}" for the Agent Owner client`,
    );
    return;
  }
  let email = await findConnection(api, EMAIL_CONNECTION);
  if (!email) {
    email = await api("POST", "connections", {
      name: EMAIL_CONNECTION,
      strategy: "email",
      options: {
        disable_signup: false,
        brute_force_protection: true,
        totp: { time_step: 300, length: 6 },
        email: {
          syntax: "liquid",
          from: "{{ application.name }} <root@auth0.com>",
          subject: "Your {{ application.name }} sign-in code",
          body: "<html><body><p>Your sign-in code is <strong>{{ code }}</strong>.</p><p>It expires in 5 minutes.</p></body></html>",
        },
      },
    });
    say(`DO   created passwordless connection "${EMAIL_CONNECTION}"`);
  } else say(`SKIP connection "${EMAIL_CONNECTION}" exists`);
  const spa = state.clients?.spa?.client_id;
  const owner = state.clients?.agentOwner?.client_id;
  const org = state.organization?.id;
  await enableForClient(api, email, spa);
  say(`DO   enabled "${EMAIL_CONNECTION}" for the Policy Desk app`);
  const enabled =
    (await api("GET", `organizations/${org}/enabled_connections`)) ?? [];
  const list = Array.isArray(enabled)
    ? enabled
    : (enabled.enabled_connections ?? []);
  if (!list.some((c) => c.connection_id === email.id)) {
    await api("POST", `organizations/${org}/enabled_connections`, {
      connection_id: email.id,
      assign_membership_on_login: true,
    });
    say(
      `DO   enabled "${EMAIL_CONNECTION}" on the organization (auto-membership)`,
    );
  } else say(`SKIP "${EMAIL_CONNECTION}" already on the organization`);
  const db = await findConnection(api, o.connection);
  if (!db) throw new SetupError(`Connection "${o.connection}" not found.`);
  await enableForClient(api, db, owner);
  say(`DO   enabled "${o.connection}" for the Agent Owner client`);
}

/** Writes auth0/service/fga/model.fga unless the store's latest model already matches. Returns its id. */
export async function ensureFgaModel(fga, { fetchImpl = fetch, dsl, toJson }) {
  const tokenRes = await fetchImpl(fga.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: fga.clientId,
      client_secret: fga.clientSecret,
      audience: fga.tokenAudience,
    }),
  });
  if (!tokenRes.ok)
    throw new SetupError(
      `FGA token request failed (${tokenRes.status}). Check FGA_CLIENT_ID/SECRET and FGA_API_URL.`,
    );
  const { access_token } = await tokenRes.json();
  const headers = {
    authorization: `Bearer ${access_token}`,
    "content-type": "application/json",
  };
  const base = `${fga.apiUrl}/stores/${fga.storeId}/authorization-models`;
  const want = toJson(dsl);
  const latest = await fetchImpl(`${base}?page_size=1`, { headers });
  if (!latest.ok)
    throw new SetupError(
      `FGA read failed (${latest.status}). The client needs "Read and query" and "Write and delete authorization models" on store ${fga.storeId}.`,
    );
  const current = (await latest.json()).authorization_models?.[0];
  if (current && sameModel(current, want))
    return { id: current.id, written: false };
  const res = await fetchImpl(base, {
    method: "POST",
    headers,
    body: JSON.stringify(want),
  });
  if (!res.ok)
    throw new SetupError(
      `FGA model write failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
    );
  return { id: (await res.json()).authorization_model_id, written: true };
}

/** Creates (or re-keys) the DML-only runtime role, then applies migrations and grants as the owner. */
export async function prepareDatabase(ownerUrl, { pg, migrate, password }) {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const exists = await client.query(
      "select 1 from pg_roles where rolname = $1",
      [RUNTIME_ROLE],
    );
    // A role password cannot be a bind parameter; the generated value is hex only.
    if (!/^[a-f0-9]{32,}$/.test(password))
      throw new SetupError("unexpected password format");
    await client.query(
      `${exists.rowCount ? "alter" : "create"} role ${RUNTIME_ROLE} with login password '${password}'`,
    );
  } finally {
    await client.end();
  }
  await migrate(ownerUrl);
  return runtimeDatabaseUrl(ownerUrl, password);
}

/** Runs a command with optional stdin, capturing output. Never rejects. `interactive` hands it the terminal. */
function exec(
  cmd,
  args,
  { input, env, cwd = REPO_ROOT, inherit, interactive } = {},
) {
  return new Promise((res) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: interactive
        ? "inherit"
        : inherit
          ? ["pipe", "inherit", "inherit"]
          : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) => res({ code: 127, stdout, stderr: String(e) }));
    child.on("close", (code) => res({ code, stdout, stderr }));
    child.stdin?.end(input);
  });
}

const wranglerArgs = (o, ...rest) => [
  "wrangler",
  ...rest,
  "--config",
  join(REPO_ROOT, "wrangler.jsonc"),
  "--name",
  o.worker,
];

/** Asks one question on the terminal. Secret answers are not echoed. */
async function ask(question, { secret = false, fallback } = {}) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    const q = `${question}${fallback ? ` [${fallback}]` : ""}: `;
    const pending = rl.question(q);
    if (secret) rl._writeToOutput = () => {};
    const answer = (await pending).trim();
    if (secret) process.stdout.write("\n");
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

const configPath = (home) => join(home, ".policy-desk", "setup.json");

export function defaultDeps() {
  const home = homedir();
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    home,
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    run: realRunner(),
    exec,
    fetchImpl: fetch,
    provision: provisionMain,
    alexLogin: async (argv, deps) =>
      (await import("./alex-login.mjs")).main(argv, deps),
    pg: async () => (await import("pg")).default,
    toJson: async () => {
      const { transformer } = await import("@openfga/syntax-transformer");
      return (dsl) => JSON.parse(transformer.transformDSLToJSON(dsl));
    },
    readFile: (p) => readFileSync(p, "utf8"),
    readState: (p) => JSON.parse(readFileSync(p, "utf8")),
    random: (n) => randomBytes(n).toString("hex"),
    prompt: tty ? ask : undefined,
    loadConfig: () => {
      try {
        return JSON.parse(readFileSync(configPath(home), "utf8"));
      } catch {
        return {};
      }
    },
    saveConfig: (c) => {
      const p = configPath(home);
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
      chmodSync(p, 0o600);
    },
    // The Auth0 CLI keeps each tenant's granted scopes here (best effort: absent means "don't know").
    auth0Scopes: (tenant) => {
      const p = join(home, ".config", "auth0", "config.json");
      if (!existsSync(p)) return null;
      try {
        const scopes = JSON.parse(readFileSync(p, "utf8"))?.tenants?.[tenant]
          ?.scopes;
        return Array.isArray(scopes) ? scopes : null;
      } catch {
        return null;
      }
    },
  };
}

/** Tenant domains in `auth0 tenants list` output, in order. */
export function listedTenants(stdout) {
  return [
    ...new Set(
      String(stdout).match(
        /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.auth0\.com\b/g,
      ) ?? [],
    ),
  ];
}

/** workers.dev URL from `wrangler deploy` output. */
export function deployedOrigin(stdout) {
  return String(stdout).match(
    /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/,
  )?.[0];
}

/**
 * Fills argv and env from the remembered answers and, on a terminal, from questions. Returns the
 * argv and env to parse. Nothing here writes anywhere.
 */
export async function gather(argv, env, deps, { tenants = [] } = {}) {
  const args = [...argv];
  const e = { ...env };
  const has = (f) => args.includes(f);
  const saved = deps.loadConfig?.() ?? {};
  for (const [k, flag] of Object.entries(REMEMBERED))
    if (!has(flag) && saved[k]) args.push(flag, saved[k]);
  for (const [k, name] of [
    ["fgaStoreId", "FGA_STORE_ID"],
    ["fgaClientId", "FGA_CLIENT_ID"],
    ["fgaApiUrl", "FGA_API_URL"],
  ])
    if (!e[name] && saved[k]) e[name] = saved[k];
  const ask = !has("--yes") && !has("--help") && !has("-h") && deps.prompt;
  if (!ask) return { args, env: e };
  const q = async (flag, question, opts) => {
    if (has(flag)) return;
    const v = await deps.prompt(question, opts);
    if (v) args.push(flag, v);
  };
  const qEnv = async (name, question, opts) => {
    if (e[name]) return;
    const v = await deps.prompt(question, opts);
    if (v) e[name] = v;
  };
  await q("--tenant", "Auth0 tenant domain", { fallback: tenants[0] });
  if (!has("--deploy"))
    await q(
      "--origin",
      "Your Worker's URL (the Deploy button shows it, e.g. https://mcp-tasks.<you>.workers.dev)",
    );
  await q("--admin-email", "Your email (you sign in with it; it gets /admin)");
  if (has("--verify") || has("--dry-run")) return { args, env: e };
  await qEnv(
    "OWNER_DATABASE_URL",
    "Postgres owner connection string (postgres://...; used once, not stored)",
    { secret: true },
  );
  await qEnv("FGA_STORE_ID", "Auth0 FGA store ID");
  await qEnv("FGA_CLIENT_ID", "Auth0 FGA client ID");
  await qEnv("FGA_CLIENT_SECRET", "Auth0 FGA client secret (not stored)", {
    secret: true,
  });
  return { args, env: e };
}

/** Entry point. Returns the process exit code. */
export async function main(argv, depsIn = {}, env = process.env) {
  const deps = { ...defaultDeps(), ...depsIn };
  const scrubber = makeScrubber();
  const say = (l) => deps.out(scrubber.scrub(l));
  let n = 0;
  const step = (l) => say(`\n[${++n}] ${l}`);
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      deps.out(USAGE);
      return 0;
    }
    const interactive = Boolean(deps.prompt) && !argv.includes("--yes");
    say(
      "MCP Tasks setup: Auth0, FGA, Postgres and Worker secrets. Safe to re-run.",
    );

    step("Auth0 CLI and Wrangler");
    let who = await deps.exec("auth0", ["tenants", "list"]);
    if (who.code === 127)
      throw new SetupError(
        "The Auth0 CLI is not installed. Install it (brew install auth0/auth0-cli/auth0, or https://github.com/auth0/auth0-cli#installation) and re-run.",
      );
    const login = async (why) => {
      if (!interactive)
        throw new SetupError(
          `${why} Run: auth0 ${AUTH0_LOGIN.slice(0, 2).join(" ")} "${AUTH0_SCOPES.join(",")}" (choose "As a user"), then re-run.`,
        );
      say(`${why} Opening the Auth0 CLI login: choose "As a user".`);
      await deps.exec("auth0", AUTH0_LOGIN, { interactive: true });
      who = await deps.exec("auth0", ["tenants", "list"]);
    };
    if (who.code !== 0) await login("The Auth0 CLI is not logged in.");
    if (who.code !== 0)
      throw new SetupError("The Auth0 CLI is still not logged in.");

    const g = await gather(argv, env, deps, {
      tenants: listedTenants(who.stdout),
    });
    let args = g.args;
    const wr = await deps.exec("npx", ["wrangler", "whoami"]);
    if (
      wr.code !== 0 ||
      /not authenticated/i.test(`${wr.stdout}${wr.stderr}`)
    ) {
      if (!interactive)
        throw new SetupError(
          "Wrangler is not logged in. Run: npx wrangler login",
        );
      say("Wrangler is not logged in. Opening its login.");
      const l = await deps.exec("npx", ["wrangler", "login"], {
        interactive: true,
      });
      if (l.code !== 0) throw new SetupError("wrangler login did not finish.");
    }

    // --deploy without --origin: deploy first and read the URL Wrangler prints.
    let deployed = false;
    if (args.includes("--deploy") && !args.includes("--origin")) {
      const worker = args[args.indexOf("--worker") + 1];
      const name = args.includes("--worker") ? worker : "mcp-tasks";
      step(`Deploying the Worker ${name}`);
      const url = await deploy(deps, { worker: name }, true);
      if (!url)
        throw new SetupError(
          "wrangler deploy did not print a workers.dev URL. Re-run with --origin <your Worker URL>.",
        );
      args = [...args, "--origin", url];
      deployed = true;
      say(`DO   deployed to ${url}`);
    }

    const o = parseArgs(args, g.env, deps.home);
    const tenantsNow = listedTenants(who.stdout);
    if (!who.stdout.includes(o.tenant)) {
      await login(`The Auth0 CLI is not logged in to ${o.tenant}.`);
      if (!who.stdout.includes(o.tenant))
        throw new SetupError(
          `The Auth0 CLI is logged in to ${tenantsNow.join(", ") || "no tenant"}, not ${o.tenant}.`,
        );
    }
    const granted = deps.auth0Scopes?.(o.tenant);
    const lacking = granted
      ? AUTH0_SCOPES.filter((s) => !granted.includes(s))
      : [];
    if (lacking.length && !o.verify) {
      await login(
        `The Auth0 CLI login for ${o.tenant} lacks ${lacking.length} scope(s) setup needs (${lacking.slice(0, 3).join(", ")}${lacking.length > 3 ? ", ..." : ""}).`,
      );
    }
    say(`OK   Auth0 CLI on ${o.tenant}; Wrangler logged in`);
    const api = auth0Api(deps.run, o.tenant, scrubber);

    if (o.verify)
      return await verifyStep(deps, api, o, say, () =>
        step("Checking everything (read only)"),
      );

    if (!o.dryRun)
      deps.saveConfig?.({
        tenant: o.tenant,
        origin: o.origin,
        worker: o.worker,
        alexEmail: o.alexEmail,
        ...(o.adminEmail ? { adminEmail: o.adminEmail } : {}),
        fgaStoreId: o.fga.storeId,
        fgaClientId: o.fga.clientId,
        fgaApiUrl: o.fga.apiUrl,
      });
    scrubber.add(o.fga.clientSecret);
    scrubber.add(new URL(o.databaseUrl).password);

    step(`Auth0 tenant ${o.tenant}`);
    if (o.mfa) await enableMfa(api, say, o.dryRun);
    else say("SKIP MFA factors (--no-mfa): high-value approvals need WebAuthn");
    const pArgs = [
      "--tenant",
      o.tenant,
      "--origin",
      o.origin,
      "--connection",
      o.connection,
      "--create-alex",
      o.alexEmail,
      "--state",
      o.state,
      "--vars-out",
      o.varsOut,
      ...(o.dryRun ? [] : ["--apply"]),
    ];
    if ((await deps.provision(pArgs)) !== 0)
      throw new SetupError(
        "Auth0 provisioning failed (see above). Fix it and re-run; finished steps are skipped.",
      );
    if (o.dryRun) {
      await ensureLoginConnections(api, {}, o, say);
      await applyUlText(api, { apply: false, say });
      say(
        "\nDry run: Auth0 changes were printed, nothing else was touched. Re-run without --dry-run.",
      );
      return 0;
    }
    const state = deps.readState(o.state);
    for (const c of Object.values(state.clients ?? {}))
      scrubber.add(c.client_secret);
    scrubber.add(state.alex?.password);
    await ensureLoginConnections(api, state, o, say);

    step("Universal Login text (sign-in, passkey and authenticator screens)");
    try {
      const wrote = await applyUlText(api, { apply: true, say });
      if (wrote.length) say(`DO   wrote custom text for ${wrote.join(", ")}`);
    } catch (e) {
      say(
        `WARN Universal Login text not written (${scrubber.scrub(String(e?.message ?? e)).slice(0, 200)}). Sign-in works with Auth0's default copy; the check at the end will flag it.`,
      );
    }

    step("Auth0 FGA authorization model");
    const fgaModel = await ensureFgaModel(o.fga, {
      fetchImpl: deps.fetchImpl,
      dsl: deps.readFile(join(REPO_ROOT, "auth0/service/fga/model.fga")),
      toJson: await deps.toJson(),
    });
    say(
      `${fgaModel.written ? "DO   wrote" : "SKIP store already has"} model ${fgaModel.id}`,
    );

    step("Postgres: runtime role, migrations and grants (as the owner)");
    const password = deps.random(24);
    scrubber.add(password);
    const databaseUrl = await prepareDatabase(o.databaseUrl, {
      pg: await deps.pg(),
      password,
      migrate: async (url) => {
        const r = await deps.exec(
          "node",
          ["--import", "tsx", "demo/policy-desk/tools/migrate.ts"],
          { env: { OWNER_DATABASE_URL: url } },
        );
        if (r.code !== 0)
          throw new SetupError(
            `Migration failed: ${scrubber.scrub(r.stderr).split("\n").slice(-5).join(" ")}`,
          );
      },
    });
    say(`DO   role ${RUNTIME_ROLE} ready; schema migrated`);

    if (o.deploy && !deployed) {
      step("Deploying the Worker");
      await deploy(deps, o, false);
    }

    step(`Worker secrets on ${o.worker}`);
    const secrets = workerSecrets({
      state,
      fga: o.fga,
      modelId: fgaModel.id,
      databaseUrl,
      o,
      salt: deps.random(32),
    });
    const put = await deps.exec("npx", wranglerArgs(o, "secret", "bulk"), {
      input: JSON.stringify(secrets),
    });
    if (put.code !== 0)
      throw new SetupError(
        `wrangler secret bulk failed. Is the Worker "${o.worker}" deployed in this account? Use the Deploy button or add --deploy. ${scrubber.scrub(put.stderr).split("\n").slice(-4).join(" ")}`,
      );
    say(`DO   stored ${Object.keys(secrets).length} secrets (names only):`);
    say(`     ${Object.keys(secrets).join(", ")}`);

    step("Delegating user sign-in (opens your browser once)");
    if (o.skipAlexLogin)
      say(
        "SKIP the agent cannot act until you re-run setup without --skip-alex-login",
      );
    else {
      say(
        `Sign in as ${o.alexEmail}. Its password is in ${o.state} under alex.password.`,
      );
      const code = await deps.alexLogin(["--state", o.state], {
        putSecret: (value) =>
          deps.exec(
            "npx",
            wranglerArgs(o, "secret", "put", "AGENT_OWNER_REFRESH_TOKEN"),
            { input: value },
          ),
      });
      if (code !== 0)
        throw new SetupError(
          "The delegating user's sign-in did not finish. Re-run setup; finished steps are skipped.",
        );
    }

    return await verifyStep(deps, api, o, say, () =>
      step("Checking everything (read only)"),
    );
  } catch (e) {
    const msg =
      e instanceof SetupError || e instanceof ProvisionError
        ? e.message
        : `Unexpected error: ${e?.message ?? e}`;
    deps.err(`\nERROR: ${scrubber.scrub(msg)}`);
    if (/insufficient_scope|\(403\)/.test(msg))
      deps.err(
        `Hint: the Auth0 CLI login lacks a scope. Run: auth0 login --scopes "${AUTH0_SCOPES.join(",")}"`,
      );
    return 1;
  }
}

/** Builds the UI and runs wrangler deploy. Returns the workers.dev URL when Wrangler prints one. */
async function deploy(deps, o, capture) {
  const b = await deps.exec("npm", ["run", "build:web"], { inherit: true });
  if (b.code !== 0) throw new SetupError("npm run build:web failed.");
  const d = await deps.exec("npx", wranglerArgs(o, "deploy"), {
    inherit: !capture,
  });
  if (d.code !== 0)
    throw new SetupError(
      `wrangler deploy failed. ${String(d.stderr).split("\n").slice(-4).join(" ")}`,
    );
  return deployedOrigin(d.stdout);
}

/** The read-only checks, the Worker's health and what to do next. Returns the exit code. */
async function verifyStep(deps, api, o, say, header) {
  header();
  let state;
  try {
    state = deps.readState(o.state);
  } catch {
    say(
      `  ✗ No Auth0 state file at ${o.state}\n      Fix: run \`npm run setup\` (without --verify) first.`,
    );
    return 1;
  }
  const checks = await verifyAuth0(
    api,
    state,
    {
      origin: o.origin,
      connection: o.connection,
      mfa: o.mfa,
    },
    { readFile: deps.readFile },
  );
  const health = await deps
    .fetchImpl(`${o.origin}/healthz`)
    .then((r) => r.status)
    .catch(() => 0);
  const worker =
    health === 200
      ? { ok: true, label: "Worker answers /healthz", detail: o.origin }
      : {
          ok: false,
          label: "Worker answers /healthz",
          detail: health ? `HTTP ${health}` : "no answer",
          fix: `Deploy the Worker (Deploy button or --deploy); \`npm run doctor -- --url ${o.origin}\` explains a 503.`,
        };
  const authOk = report(checks, say, { tenant: o.tenant, after: [worker] });
  if (authOk && health === 200) {
    say(
      `\nAll set. Open ${o.origin}, sign in with ${o.adminEmail ?? "your email"}, and follow "Your first approval" in docs/deploy-cloudflare.md.`,
    );
    return 0;
  }
  say(
    "\nRe-run `npm run setup` to fix what failed; finished steps are skipped.",
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
