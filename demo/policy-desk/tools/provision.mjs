#!/usr/bin/env node
// Additive, idempotent provisioning of the Auth0 side of the Policy Desk demo, through the Auth0 CLI's
// generic `auth0 api <method> <path> --tenant <domain> --no-input` command (no dependencies, Node 22).
//
//   node demo/policy-desk/tools/provision.mjs \
//     --tenant <tenant>.us.auth0.com --origin https://<worker-origin> --connection <existing connection> \
//     [--apply | --destroy [--apply]] [--state <path>] [--vars-out <path>]
//
// Default is a DRY RUN: every planned call is printed (method, path, redacted body) and nothing is
// written. Read-only GETs are still performed so the plan reflects the tenant.
//
// Safety model:
//   * Every object this script creates or changes is named `policy-desk ...` / `Policy Desk ...`.
//     `Api.write` refuses any write whose target name does not carry that prefix.
//   * It never edits existing APIs, clients, connections, organizations, users, MFA settings, branding,
//     tenant settings or other Actions. The post-login flow is the one shared object it must touch: it
//     fetches the current bindings and PATCHes them back with every existing binding (same id, same
//     order) plus the two new Actions appended; `assertBindingsPreserved` enforces that.
//   * Secrets (client secrets, the generated Alex password) go only to the state file (0600, outside
//     the repo). Stdout and error text are scrubbed of every secret value seen.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../..");

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------
export const ORG_NAME = "policy-desk";
export const ORG_DISPLAY = "Policy Desk";
export const RS_NAME = "Policy Desk Task Authority";
// Universal Login shows the app name to visitors (page title, sign-in copy, email subject).
export const SPA_NAME = "Policy Desk";
/** Earlier names of owned clients, renamed in place on the next run instead of duplicated. */
export const LEGACY_CLIENT_NAMES = { spa: ["Policy Desk SPA"] };
export const ALEX_NAME = "policy-desk-alex";
/** Confidential client through which Alex (the agent's delegating user) obtains a refresh token once. */
export const AGENT_OWNER = {
  key: "agentOwner",
  name: "Policy Desk Agent Owner",
  env: "AGENT_OWNER",
};
export const ALEX_CALLBACK = "http://127.0.0.1:53682/callback";
export const RAR_TYPE = "task_authority_approval";
export const LOCAL_ORIGINS = ["http://127.0.0.1:8787", "http://localhost:8787"];

export const PERMISSIONS = [
  "delegations:create",
  "delegations:read",
  "operations:register",
  "operations:read",
  "operations:cancel",
  "approvals:request",
  "approvals:read",
  "approvals:decide",
  "claims:create",
  "outcomes:report",
  "audit:read",
  "usage:read",
  "policies:write",
  "policies:read",
];

// key -> client name, Worker env var prefix, permissions (exactly the PROVISIONING.md table).
export const M2M = {
  api: {
    name: "Policy Desk Authority API",
    env: "AUTHORITY_API",
    scopes: [
      "delegations:create",
      "delegations:read",
      "operations:register",
      "operations:read",
      "operations:cancel",
      "approvals:request",
      "approvals:read",
    ],
  },
  executor: {
    name: "Policy Desk Authority Executor",
    env: "AUTHORITY_EXECUTOR",
    scopes: ["operations:read", "claims:create", "outcomes:report"],
  },
  auditor: {
    name: "Policy Desk Authority Auditor",
    env: "AUTHORITY_AUDITOR",
    scopes: [
      "usage:read",
      "audit:read",
      "operations:read",
      "delegations:read",
      "approvals:read",
    ],
  },
  admin: {
    name: "Policy Desk Authority Admin",
    env: "AUTHORITY_ADMIN",
    scopes: ["policies:write", "policies:read"],
  },
  agent: { name: "Policy Desk Agent", env: "AGENT", scopes: [] },
  // Tokens handed to visitors' own agents as sandbox agent keys (src/agent-keys.ts).
  externalAgent: {
    name: "Policy Desk External Agent",
    env: "EXTERNAL_AGENT",
    scopes: [],
  },
};

export const ACTIONS = [
  {
    key: "approval",
    name: "policy-desk task-authority-approval",
    file: "auth0/actions/task-authority-approval.cjs",
    secrets: false,
  },
  {
    key: "assurance",
    name: "policy-desk task-authority-assurance",
    file: "auth0/actions/task-authority-assurance.cjs",
    secrets: true,
  },
];

export const MANUAL_SECRETS = [
  "AGENT_OWNER_REFRESH_TOKEN",
  "FGA_API_TOKEN",
  "FGA_ADMIN_TOKEN",
  "IP_HASH_SALT",
];

export class ProvisionError extends Error {
  constructor(message, { status, path } = {}) {
    super(message);
    this.name = "ProvisionError";
    this.status = status;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------
export const isOwnedName = (name) =>
  typeof name === "string" &&
  (name.startsWith("policy-desk") || name.startsWith("Policy Desk"));

export function assertOwnedName(name, what = "object") {
  if (!isOwnedName(name))
    throw new ProvisionError(
      `Refusing to touch ${what} "${name}": not named with the policy-desk / Policy Desk prefix, so this script did not create it.`,
    );
}

const SENSITIVE_KEY =
  /password|passwd|signing_secret|private_key|credential|(^|_)secret$|(^|_)(access|refresh|id)_token$|^token$|^totp/i;

export function redact(value, key = "") {
  if (key === "secrets" && Array.isArray(value))
    return value.map((s) => ({ ...s, value: "[REDACTED]" }));
  if (typeof value === "string") {
    if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (key === "code")
      return `[${value.length} chars sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}]`;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v, k)]),
    );
  return value;
}

export function makeScrubber() {
  const secrets = new Set();
  return {
    add(v) {
      if (typeof v === "string" && v.length >= 6) secrets.add(v);
    },
    scrub(text) {
      let out = String(text);
      for (const s of secrets) out = out.split(s).join("[REDACTED]");
      return out;
    },
  };
}

export function expandHome(p, home = homedir()) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function realpathDeep(p) {
  // Resolve symlinks for the deepest existing ancestor, then re-append the rest.
  let cur = resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    rest.unshift(cur.slice(dirname(cur).length + 1));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return join(realpathSync(cur), ...rest);
}

export function assertOutsideRepo(path, repoRoot = REPO_ROOT) {
  const target = realpathDeep(path);
  const root = realpathSync(repoRoot);
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
    throw new ProvisionError(
      `Refusing path ${path}: it is inside the repository (${root}). Secrets must not live in the repo; use a path such as ~/.policy-desk/.`,
    );
  return target;
}

export function parseArgs(argv, home = homedir()) {
  const valued = new Set([
    "--tenant",
    "--origin",
    "--connection",
    "--state",
    "--vars-out",
    "--create-alex",
  ]);
  const flags = new Set(["--apply", "--destroy", "--help"]);
  const o = {
    apply: false,
    destroy: false,
    help: false,
    state: join(home, ".policy-desk", "auth0-state.json"),
    varsOut: join(home, ".policy-desk", "wrangler-vars.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) {
      o[a.slice(2)] = true;
    } else if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--"))
        throw new ProvisionError(`${a} needs a value`);
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      o[key] = v;
    } else throw new ProvisionError(`Unknown argument: ${a}`);
  }
  if (o.help) return o;
  for (const need of ["tenant", "origin", "connection"])
    if (!o[need]) throw new ProvisionError(`--${need} is required`);
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(o.tenant))
    throw new ProvisionError(`--tenant must be a hostname, got "${o.tenant}"`);
  let u;
  try {
    u = new URL(o.origin);
  } catch {
    throw new ProvisionError(`--origin is not a URL: ${o.origin}`);
  }
  if (u.protocol !== "https:" || u.pathname !== "/" || u.search || u.hash)
    throw new ProvisionError(
      "--origin must be an https origin without a path, e.g. https://mcp-tasks.example.com",
    );
  o.origin = u.origin;
  o.state = resolve(expandHome(o.state, home));
  o.varsOut = resolve(expandHome(o.varsOut, home));
  if (o.createAlex && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.createAlex))
    throw new ProvisionError("--create-alex needs an email address");
  return o;
}

/** Structural comparison where arrays of strings compare as sets and objects compare as a subset. */
export function subsetEqual(current, desired) {
  if (Array.isArray(desired)) {
    if (!Array.isArray(current) || current.length !== desired.length)
      return false;
    if (desired.every((x) => typeof x === "string"))
      return [...desired].sort().join("\0") === [...current].sort().join("\0");
    return desired.every((d, i) => subsetEqual(current[i], d));
  }
  if (desired && typeof desired === "object") {
    if (!current || typeof current !== "object") return false;
    return Object.entries(desired).every(([k, v]) =>
      subsetEqual(current[k], v),
    );
  }
  return current === desired;
}

/** The subset of `desired` fields that differ from `current` (only fields the script manages). */
export function diffManaged(current, desired) {
  const out = {};
  for (const [k, v] of Object.entries(desired)) {
    if (k === "scopes") {
      const a = (current.scopes ?? []).map((s) => s.value).sort();
      const b = v.map((s) => s.value).sort();
      if (a.join("\0") !== b.join("\0")) out[k] = v;
    } else if (!subsetEqual(current[k], v)) out[k] = v;
  }
  return out;
}

export function describeBinding(b) {
  return `${b.display_name ?? b.action?.name ?? "?"} (${b.id ?? b.action?.id ?? "new"})`;
}

/**
 * Append `wanted` Actions ([{id,name}]) to the end of an existing binding list, in order, skipping
 * any that are already bound. Existing bindings are referenced by binding id so their order and
 * settings (including binding-level secrets) are preserved by the replace-all PATCH.
 */
export function appendBindings(existing, wanted) {
  const isBound = (w) =>
    existing.some((b) => b.action?.id === w.id || b.action?.name === w.name);
  const missing = wanted.filter((w) => !isBound(w));
  const warnings = [];
  const wantedNames = wanted.map((w) => w.name);
  const boundOrder = existing
    .map((b) => b.action?.name)
    .filter((n) => wantedNames.includes(n));
  for (let i = 1; i < boundOrder.length; i++)
    if (
      wantedNames.indexOf(boundOrder[i]) <
      wantedNames.indexOf(boundOrder[i - 1])
    )
      warnings.push(
        "The two Policy Desk Actions are already bound in the wrong order (approval must run before assurance). Not reordering automatically; fix in the dashboard.",
      );
  const earlierBoundLater = missing.find((m) =>
    wanted
      .slice(wanted.indexOf(m) + 1)
      .some((later) => isBound(later) && !missing.includes(later)),
  );
  if (earlierBoundLater)
    warnings.push(
      `${earlierBoundLater.name} is missing but a later Policy Desk Action is already bound; appending it would run it after. Bind it manually in the right place.`,
    );
  const payload = [
    ...existing.map((b) => ({
      ref: { type: "binding_id", value: b.id },
      display_name: b.display_name,
    })),
    ...(earlierBoundLater
      ? []
      : missing.map((w) => ({
          ref: { type: "action_id", value: w.id },
          display_name: w.name,
        }))),
  ];
  const added = earlierBoundLater ? [] : missing;
  return {
    changed: added.length > 0,
    payload,
    added,
    before: existing.map(describeBinding),
    after: [
      ...existing.map(describeBinding),
      ...added.map((w) => `${w.name} (${w.id}) [NEW]`),
    ],
    warnings,
  };
}

/** Throws unless every existing binding survives, in order, and only `allowedRemoved` names vanish. */
export function assertBindingsPreserved(
  existing,
  payload,
  allowedRemoved = [],
) {
  const keptIds = payload
    .filter((p) => p.ref?.type === "binding_id")
    .map((p) => p.ref.value);
  const expected = existing
    .filter((b) => !allowedRemoved.includes(b.action?.name))
    .map((b) => b.id);
  if (JSON.stringify(keptIds) !== JSON.stringify(expected))
    throw new ProvisionError(
      "Internal safety check failed: the new post-login binding list would drop or reorder an existing binding. Nothing was changed.",
    );
  const firstNew = payload.findIndex((p) => p.ref?.type !== "binding_id");
  if (
    firstNew !== -1 &&
    payload.slice(firstNew).some((p) => p.ref?.type === "binding_id")
  )
    throw new ProvisionError(
      "Internal safety check failed: new bindings must be appended after all existing ones.",
    );
  for (const p of payload)
    if (p.ref?.type !== "binding_id")
      assertOwnedName(p.display_name, "Action binding");
}

export function envNames() {
  const all = [...Object.values(M2M), AGENT_OWNER];
  const ids = all.map((c) => `${c.env}_CLIENT_ID`);
  const secs = all.map((c) => `${c.env}_CLIENT_SECRET`);
  return { ids, secs };
}

export function buildVarsFile({ domain, audience, state }) {
  const { ids, secs } = envNames();
  const clientIds = {};
  for (const [k, c] of Object.entries(M2M))
    clientIds[`${c.env}_CLIENT_ID`] = state.clients?.[k]?.client_id ?? "";
  clientIds.AGENT_OWNER_CLIENT_ID =
    state.clients?.[AGENT_OWNER.key]?.client_id ?? "";
  return {
    _note:
      "Non-secret Worker vars. Put `vars` into wrangler.jsonc, set every name in `secrets` with `wrangler secret put <NAME>` (values are in the 0600 state file, never here), and set `manualSecrets` yourself.",
    vars: {
      AUTH0_DOMAIN: domain,
      TASK_AUTHORITY_AUDIENCE: audience,
      SPA_CLIENT_ID: state.clients?.spa?.client_id ?? "",
      AUTH0_ORG_ID: state.organization?.id ?? "",
      AGENT_ID: "agent_returns",
    },
    clientIds,
    secrets: [...ids, ...secs],
    manualSecrets: MANUAL_SECRETS,
  };
}

export function secretValuesFromState(state) {
  const { ids, secs } = envNames();
  const out = {};
  for (const [k, c] of Object.entries(M2M)) {
    out[`${c.env}_CLIENT_ID`] = state.clients?.[k]?.client_id;
    out[`${c.env}_CLIENT_SECRET`] = state.clients?.[k]?.client_secret;
  }
  out.AGENT_OWNER_CLIENT_ID = state.clients?.[AGENT_OWNER.key]?.client_id;
  out.AGENT_OWNER_CLIENT_SECRET =
    state.clients?.[AGENT_OWNER.key]?.client_secret;
  void ids;
  void secs;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Auth0 CLI transport
// ---------------------------------------------------------------------------------------------
/** Real runner: execFile with an args array (never a shell string). Never rejects on non-zero exit. */
export function realRunner(bin = "auth0") {
  return (args, { input } = {}) =>
    new Promise((res) => {
      const child = execFile(
        bin,
        args,
        { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
        (err, stdout, stderr) =>
          res({
            code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
            stdout: String(stdout ?? ""),
            stderr:
              String(stderr ?? "") +
              (err && !stderr ? String(err.message) : ""),
          }),
      );
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
}

export function parseCliJson(stdout) {
  const t = String(stdout).trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    const i = t.search(/[[{]/);
    if (i === -1)
      throw new ProvisionError("auth0 CLI returned non-JSON output");
    try {
      return JSON.parse(t.slice(i));
    } catch {
      throw new ProvisionError("auth0 CLI returned unparseable JSON on stdout");
    }
  }
}

export function parseCliError(stderr) {
  const s = String(stderr);
  const m = s.match(/(\d{3}): API request failed:\s*(.*)/s);
  let status = m ? Number(m[1]) : undefined;
  let message = m ? m[2] : s;
  try {
    const j = JSON.parse(message.trim().replace(/\.$/, ""));
    message = j.message ?? j.error_description ?? j.error ?? message;
    status = j.statusCode ?? status;
  } catch {
    /* keep raw */
  }
  message = message
    .split("\n")
    .filter((l) => !/Agent mode on/.test(l) && l.trim())
    .join(" ")
    .trim();
  if (status === undefined && /rate.?limit|too many requests/i.test(s))
    status = 429;
  return { status, message: message.slice(0, 500) || "unknown error" };
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export class Api {
  constructor({ run, tenant, dryRun, sleep, scrubber, log }) {
    this.run = run;
    this.tenant = tenant;
    this.dryRun = dryRun;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.scrubber = scrubber ?? makeScrubber();
    this.log = log ?? (() => {});
    this.calls = [];
  }

  async #exec(method, path, body, { sensitive } = {}) {
    const args = [
      "api",
      method.toLowerCase(),
      path,
      "--tenant",
      this.tenant,
      "--no-input",
    ];
    let input;
    if (body !== undefined) {
      // Bodies carrying secrets go over stdin so they never appear in the process list.
      if (sensitive) input = JSON.stringify(body);
      else args.push("--data", JSON.stringify(body));
    }
    if (method === "DELETE") args.push("--force");
    for (let attempt = 0; ; attempt++) {
      const r = await this.run(args, { input });
      if (r.code === 0) return { status: 200, json: parseCliJson(r.stdout) };
      const e = parseCliError(r.stderr);
      if (e.status === 429 && attempt < BACKOFF_MS.length) {
        await this.sleep(BACKOFF_MS[attempt]);
        continue;
      }
      throw new ProvisionError(
        this.scrubber.scrub(
          `${method} ${path.split("?")[0]} failed${e.status ? ` (${e.status})` : ""}: ${e.message}`,
        ),
        { status: e.status, path },
      );
    }
  }

  /** Read-only. Returns parsed JSON; with allow404 returns null for 404. */
  async get(path, { allow404 = false } = {}) {
    try {
      this.calls.push(["GET", path]);
      return (await this.#exec("GET", path)).json;
    } catch (e) {
      if (allow404 && e.status === 404) return null;
      throw e;
    }
  }

  /** Paginate a list endpoint (array or `{ [key]: [] }` responses). */
  async list(path, key, { perPage = 100, totals = true } = {}) {
    const out = [];
    for (let page = 0; page < 500; page++) {
      const q = `per_page=${perPage}&page=${page}${totals ? "&include_totals=true" : ""}`;
      const res = await this.get(
        `${path}${path.includes("?") ? "&" : "?"}${q}`,
      );
      const items = Array.isArray(res) ? res : (res?.[key] ?? []);
      out.push(...items);
      if (items.length < perPage) break;
    }
    return out;
  }

  /**
   * Mutating call. `owns` names the object being written and must carry the policy-desk prefix.
   * In dry-run mode the call is only printed and a synthetic response is returned.
   */
  async write(method, path, body, { owns, sensitive, planned } = {}) {
    assertOwnedName(owns, `target of ${method} ${path.split("?")[0]}`);
    const shown =
      body === undefined
        ? ""
        : ` ${JSON.stringify(redact(body)).slice(0, 700)}`;
    this.log(`${this.dryRun ? "PLAN" : "DO  "} ${method} ${path}${shown}`);
    this.calls.push([method, path]);
    if (this.dryRun) {
      const tag = `<planned:${owns}>`;
      return {
        status: 200,
        json: {
          id: tag,
          client_id: tag,
          client_secret: "<planned-secret>",
          user_id: tag,
          ...planned,
        },
        planned: true,
      };
    }
    return this.#exec(method, path, body, { sensitive });
  }
}

const enc = encodeURIComponent;
const isPlanned = (id) => typeof id === "string" && id.startsWith("<planned:");

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------
class Ctx {
  constructor(o, deps) {
    this.o = o;
    this.deps = deps;
    this.audience = `${o.origin}/task-authority`;
    this.out = deps.out;
    this.created = [];
    this.notes = [];
    this.human = [];
    this.scrubber = makeScrubber();
    this.api = new Api({
      run: deps.run,
      tenant: o.tenant,
      dryRun: !o.apply,
      sleep: deps.sleep,
      scrubber: this.scrubber,
      log: (l) => this.say(l),
    });
    this.state = {
      version: 1,
      tenant: o.tenant,
      origin: o.origin,
      clients: {},
      actions: {},
    };
  }
  say(line) {
    this.out(this.scrubber.scrub(line));
  }
  record(line) {
    this.created.push(line);
    this.say(`${this.o.apply ? "+ " : "+ (planned) "}${line}`);
  }
  skip(line) {
    this.say(`SKIP ${line}`);
  }
  save() {
    if (!this.o.apply) return;
    this.deps.writeState(this.o.state, this.state);
  }
}

function secretsFromState(state, scrubber) {
  for (const c of Object.values(state.clients ?? {}))
    scrubber.add(c.client_secret);
  scrubber.add(state.alex?.password);
}

function rsDesired(ctx) {
  return {
    name: RS_NAME,
    signing_alg: "RS256",
    token_dialect: "access_token_authz",
    enforce_policies: true,
    allow_offline_access: true,
    skip_consent_for_verifiable_first_party_clients: true,
    scopes: PERMISSIONS.map((value) => ({ value, description: value })),
    proof_of_possession: {
      mechanism: "dpop",
      required: true,
      required_for: "public_clients",
    },
    authorization_details: [{ type: RAR_TYPE }],
  };
}

const OPTIONAL_ALIASES = {
  authorization_details:
    /authorization.?details|rich authorization|rar|entitle/i,
  proof_of_possession: /proof.?of.?possession|dpop|mtls|sender|entitle/i,
};

/** Try the write; if the tenant rejects an optional feature field, drop it, note it, and retry. */
async function writeWithOptional(ctx, method, path, body, optional, owns) {
  const cur = { ...body };
  for (;;) {
    if (method === "PATCH" && Object.keys(cur).length === 0)
      return { json: null };
    try {
      return await ctx.api.write(method, path, cur, { owns });
    } catch (e) {
      const bad = optional.find(
        (k) =>
          k in cur &&
          (e.message.toLowerCase().includes(k) ||
            OPTIONAL_ALIASES[k]?.test(e.message)),
      );
      if (![400, 403].includes(e.status) || !bad) throw e;
      delete cur[bad];
      ctx.notes.push(
        `NOTE: tenant rejected "${bad}" on the Task Authority API (${e.message}); continued without it. Configure it manually if your plan supports it.`,
      );
    }
  }
}

async function ensureResourceServer(ctx) {
  const { api } = ctx;
  const desired = rsDesired(ctx);
  const existing = await api.get(`resource-servers/${enc(ctx.audience)}`, {
    allow404: true,
  });
  let id;
  if (existing) {
    assertOwnedName(existing.name, `existing API ${ctx.audience}`);
    id = existing.id;
    const patch = diffManaged(existing, desired);
    if (Object.keys(patch).length) {
      await writeWithOptional(
        ctx,
        "PATCH",
        `resource-servers/${enc(id)}`,
        patch,
        Object.keys(OPTIONAL_ALIASES),
        RS_NAME,
      );
      ctx.record(`updated API ${RS_NAME} (${Object.keys(patch).join(", ")})`);
    } else ctx.skip(`API ${RS_NAME} already matches`);
  } else {
    const r = await writeWithOptional(
      ctx,
      "POST",
      "resource-servers",
      { identifier: ctx.audience, ...desired },
      Object.keys(OPTIONAL_ALIASES),
      RS_NAME,
    );
    id = r.json?.id;
    ctx.record(`created API ${RS_NAME} (${ctx.audience})`);
  }
  if (!ctx.o.apply)
    ctx.notes.push(
      "NOTE: the DPoP (proof_of_possession) and RAR (authorization_details) fields are attempted on the API; if the tenant rejects them on --apply, the script drops them and reports it.",
    );
  ctx.state.resourceServer = { id, identifier: ctx.audience };
  ctx.save();
  return id;
}

async function ensureOrganization(ctx, connection) {
  const { api } = ctx;
  let org = await api.get(`organizations/name/${enc(ORG_NAME)}`, {
    allow404: true,
  });
  let id;
  if (org) {
    assertOwnedName(org.name, "existing organization");
    id = org.id;
    ctx.skip(`organization ${ORG_NAME} exists (${id})`);
  } else {
    const r = await api.write(
      "POST",
      "organizations",
      { name: ORG_NAME, display_name: ORG_DISPLAY },
      { owns: ORG_NAME },
    );
    id = r.json?.id;
    ctx.record(`created organization ${ORG_NAME}`);
  }
  ctx.state.organization = { id, name: ORG_NAME };
  ctx.save();
  if (isPlanned(id)) {
    ctx.record(
      `enabled connection "${connection.name}" on ${ORG_NAME} with auto-membership`,
    );
    return id;
  }
  const enabled = await api.list(
    `organizations/${enc(id)}/enabled_connections`,
    "enabled_connections",
    { perPage: 50 },
  );
  const cur = enabled.find((c) => c.connection_id === connection.id);
  const wantSignup = connection.strategy === "auth0";
  if (!cur) {
    await api.write(
      "POST",
      `organizations/${enc(id)}/enabled_connections`,
      {
        connection_id: connection.id,
        assign_membership_on_login: true,
        ...(wantSignup ? { is_signup_enabled: true } : {}),
      },
      { owns: ORG_NAME },
    );
    ctx.record(
      `enabled connection "${connection.name}" on ${ORG_NAME} (auto-membership)`,
    );
  } else if (cur.assign_membership_on_login !== true) {
    await api.write(
      "PATCH",
      `organizations/${enc(id)}/enabled_connections/${enc(connection.id)}`,
      { assign_membership_on_login: true },
      { owns: ORG_NAME },
    );
    ctx.record(
      `set auto-membership on "${connection.name}" within ${ORG_NAME}`,
    );
  } else
    ctx.skip(
      `connection "${connection.name}" already enabled on ${ORG_NAME} with auto-membership`,
    );
  ctx.state.orgConnectionId = connection.id;
  ctx.save();
  return id;
}

async function findClientByName(ctx, name, stateEntry, legacy = []) {
  const { api } = ctx;
  const names = [name, ...legacy];
  if (stateEntry?.client_id) {
    const c = await api.get(`clients/${enc(stateEntry.client_id)}`, {
      allow404: true,
    });
    if (c && names.includes(c.name)) return c;
  }
  ctx.clientList ??= await api.list(
    "clients?fields=client_id,name&include_fields=true",
    "clients",
  );
  const hit =
    ctx.clientList.find((c) => c.name === name) ??
    ctx.clientList.find((c) => legacy.includes(c.name));
  if (!hit) return null;
  return api.get(`clients/${enc(hit.client_id)}`);
}

async function ensureClient(ctx, key, name, desired) {
  const { api } = ctx;
  assertOwnedName(name, "client");
  const existing = await findClientByName(
    ctx,
    name,
    ctx.state.clients[key],
    LEGACY_CLIENT_NAMES[key] ?? [],
  );
  let c;
  if (existing) {
    // A legacy name is renamed in place, so the client id (and every token) stays the same.
    const patch = diffManaged(existing, { name, ...desired });
    if (Object.keys(patch).length) {
      await api.write("PATCH", `clients/${enc(existing.client_id)}`, patch, {
        owns: existing.name,
      });
      ctx.record(`updated client ${name} (${Object.keys(patch).join(", ")})`);
    } else ctx.skip(`client ${name} already matches`);
    c = {
      client_id: existing.client_id,
      client_secret: existing.client_secret,
    };
  } else {
    const r = await api.write(
      "POST",
      "clients",
      { name, ...desired },
      { owns: name, sensitive: false },
    );
    c = { client_id: r.json?.client_id, client_secret: r.json?.client_secret };
    ctx.record(`created client ${name}`);
  }
  if (c.client_secret) ctx.scrubber.add(c.client_secret);
  ctx.state.clients[key] = { name, ...c };
  ctx.save();
  return c;
}

async function ensureGrant(
  ctx,
  clientKey,
  clientName,
  clientId,
  scopes,
  subjectType,
) {
  const { api } = ctx;
  let current = [];
  if (!isPlanned(clientId))
    current = await api.list(
      `client-grants?client_id=${enc(clientId)}&audience=${enc(ctx.audience)}`,
      "client_grants",
    );
  const g = current.find((x) => (x.subject_type ?? "client") === subjectType);
  if (!g) {
    await api.write(
      "POST",
      "client-grants",
      {
        client_id: clientId,
        audience: ctx.audience,
        scope: scopes,
        subject_type: subjectType,
      },
      { owns: clientName },
    );
    ctx.record(
      `created ${subjectType} grant for ${clientName} (${scopes.length} permission(s))`,
    );
  } else if (!subsetEqual(g.scope ?? [], scopes)) {
    await api.write(
      "PATCH",
      `client-grants/${enc(g.id)}`,
      { scope: scopes },
      { owns: clientName },
    );
    ctx.record(
      `updated grant for ${clientName} to exactly: ${scopes.join(", ") || "(none)"}`,
    );
  } else ctx.skip(`grant for ${clientName} already exact`);
  ctx.state.grants ??= {};
  ctx.state.grants[clientKey] = g?.id ?? "created";
  ctx.save();
}

async function ensureClients(ctx) {
  const { o } = ctx;
  const origins = [o.origin, `${o.origin}/`, ...LOCAL_ORIGINS];
  // The app returns to the root, but a review link (/review) sent by an older build must still land.
  const callbacks = [...origins, `${o.origin}/review`];
  const spa = await ensureClient(ctx, "spa", SPA_NAME, {
    app_type: "spa",
    oidc_conformant: true,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    callbacks,
    allowed_logout_urls: origins,
    // Auth0 web origins must not carry a path, so no trailing-slash variants here.
    web_origins: [o.origin, ...LOCAL_ORIGINS],
    organization_usage: "allow",
    organization_require_behavior: "no_prompt",
    require_proof_of_possession: true,
    refresh_token: {
      rotation_type: "rotating",
      expiration_type: "expiring",
      token_lifetime: 2592000,
      idle_token_lifetime: 1296000,
      leeway: 0,
    },
  });
  await ensureGrant(ctx, "spa", SPA_NAME, spa.client_id, [], "user");
  for (const [key, c] of Object.entries(M2M)) {
    const made = await ensureClient(ctx, key, c.name, {
      app_type: "non_interactive",
      grant_types: ["client_credentials"],
    });
    await ensureGrant(ctx, key, c.name, made.client_id, c.scopes, "client");
  }
  // Alex's one-time login client: confidential, auth-code + refresh, loopback callback, NON-rotating
  // refresh tokens so the Worker can reuse the stored token indefinitely.
  const owner = await ensureClient(ctx, AGENT_OWNER.key, AGENT_OWNER.name, {
    app_type: "regular_web",
    oidc_conformant: true,
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code", "refresh_token"],
    callbacks: [ALEX_CALLBACK],
    organization_usage: "allow",
    organization_require_behavior: "no_prompt",
    refresh_token: {
      rotation_type: "non-rotating",
      expiration_type: "non-expiring",
    },
  });
  await ensureGrant(
    ctx,
    AGENT_OWNER.key,
    AGENT_OWNER.name,
    owner.client_id,
    [],
    "user",
  );
}

async function waitBuilt(ctx, id) {
  if (!ctx.o.apply || isPlanned(id)) return;
  for (let i = 0; i < 60; i++) {
    const a = await ctx.api.get(`actions/actions/${enc(id)}`);
    if (a?.status === "built") return;
    if (a?.status === "failed" || a?.status === "retrying")
      throw new ProvisionError(`Action ${a.name} build ${a.status}`);
    await (ctx.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
      1000,
    );
  }
  throw new ProvisionError(`Timed out waiting for Action ${id} to build`);
}

async function ensureActions(ctx) {
  const { api } = ctx;
  const bound = [];
  for (const spec of ACTIONS) {
    assertOwnedName(spec.name, "Action");
    const code = ctx.deps.readFile(join(ctx.deps.repoRoot, spec.file));
    const secrets = spec.secrets
      ? [{ name: "TASK_AUTHORITY_AUDIENCE", value: ctx.audience }]
      : [];
    const found = (
      await api.list(
        `actions/actions?actionName=${enc(spec.name)}`,
        "actions",
        { perPage: 100, totals: false },
      )
    ).find((a) => a.name === spec.name);
    let id;
    let needsDeploy = true;
    if (!found) {
      const r = await api.write(
        "POST",
        "actions/actions",
        {
          name: spec.name,
          supported_triggers: [{ id: "post-login", version: "v3" }],
          code,
          runtime: "node22",
          ...(secrets.length ? { secrets } : {}),
        },
        { owns: spec.name },
      );
      id = r.json?.id;
      ctx.record(`created Action ${spec.name}`);
    } else {
      id = found.id;
      const patch = {};
      if (found.code !== code) patch.code = code;
      if (
        secrets.length &&
        !(found.secrets ?? []).some((s) => s.name === secrets[0].name)
      )
        patch.secrets = secrets;
      if (Object.keys(patch).length) {
        await api.write("PATCH", `actions/actions/${enc(id)}`, patch, {
          owns: spec.name,
        });
        ctx.record(
          `updated Action ${spec.name} (${Object.keys(patch).join(", ")})`,
        );
      } else {
        ctx.skip(`Action ${spec.name} code is current`);
        needsDeploy = !(
          found.status === "built" && found.all_changes_deployed === true
        );
      }
    }
    if (needsDeploy) {
      await waitBuilt(ctx, id);
      await api.write("POST", `actions/actions/${enc(id)}/deploy`, undefined, {
        owns: spec.name,
      });
      ctx.record(`deployed Action ${spec.name}`);
    }
    ctx.state.actions[spec.key] = { id, name: spec.name };
    ctx.save();
    bound.push({ id, name: spec.name });
  }
  return bound;
}

async function bindActions(ctx, wanted) {
  const { api } = ctx;
  const existing = await api.list(
    "actions/triggers/post-login/bindings",
    "bindings",
    { totals: false },
  );
  const plan = appendBindings(existing, wanted);
  ctx.say("post-login flow BEFORE:");
  plan.before.forEach((l, i) => ctx.say(`  ${i + 1}. ${l}`));
  ctx.say("post-login flow AFTER:");
  plan.after.forEach((l, i) => ctx.say(`  ${i + 1}. ${l}`));
  plan.warnings.forEach((w) => ctx.human.push(w));
  if (!plan.changed)
    return ctx.skip("both Actions already bound to post-login; flow untouched");
  assertBindingsPreserved(existing, plan.payload);
  await api.write(
    "PATCH",
    "actions/triggers/post-login/bindings",
    { bindings: plan.payload },
    { owns: "policy-desk flow bindings (append only)" },
  );
  ctx.state.boundActions = plan.added.map((w) => w.name);
  ctx.record(
    `appended ${plan.added.map((w) => w.name).join(", ")} to the end of the post-login flow`,
  );
  ctx.save();
}

async function findConnection(ctx, name) {
  const list = await ctx.api.list(
    `connections?name=${enc(name)}&fields=id,name,strategy,options&include_fields=true`,
    "connections",
  );
  const c = list.find((x) => x.name === name);
  if (!c)
    throw new ProvisionError(
      `Connection "${name}" not found on ${ctx.o.tenant}. Nothing was created.`,
    );
  return {
    id: c.id,
    name: c.name,
    strategy: c.strategy,
    disable_signup: c.options?.disable_signup,
  };
}

// Read-only reporting. Only GETs; never changes anything.
async function runChecks(ctx, connection) {
  const { api, human } = ctx;
  const factors = await api.get("guardian/factors");
  const on = (n) => (factors ?? []).find((f) => f.name === n)?.enabled === true;
  const status = ["otp", "webauthn-roaming", "webauthn-platform"].map(
    (n) => `${n}=${on(n) ? "on" : "off"}`,
  );
  ctx.say(`CHECK MFA factors (tenant-wide): ${status.join(", ")}`);
  if (!on("webauthn-roaming") && !on("webauthn-platform"))
    human.push(
      "Enable WebAuthn (roaming and/or platform) in Security > Multi-factor Auth. Without it the high-value (per_operation) tier cannot be approved. This script does not change tenant-wide MFA.",
    );
  else if (!on("webauthn-roaming") || !on("webauthn-platform"))
    ctx.say(
      "INFO  only one WebAuthn variant is enabled; that is enough for the phishing-resistant tier.",
    );
  if (!on("otp"))
    human.push(
      "OTP is off; the routine approval tier enrols OTP when no other factor exists. Enable it if you want that fallback.",
    );

  const signup = connection.disable_signup;
  ctx.say(
    `CHECK connection "${connection.name}" (${connection.strategy}) disable_signup=${signup === undefined ? "unset (sign-up allowed)" : signup}`,
  );
  if (signup === true)
    human.push(
      `Connection "${connection.name}" has sign-up disabled, so visitors cannot self-register. Enable sign-up on that connection yourself (this script does not edit connections).`,
    );
  if (
    ![
      "auth0",
      "email",
      "sms",
      "google-oauth2",
      "github",
      "apple",
      "facebook",
    ].includes(connection.strategy)
  )
    ctx.say(
      `INFO  connection strategy "${connection.strategy}" is an enterprise/other connection; confirm visitors can sign up there.`,
    );

  const rs = await api.get(
    "resource-servers?fields=identifier,proof_of_possession,authorization_details&include_fields=true&per_page=100&page=0",
  );
  const items = Array.isArray(rs) ? rs : (rs?.resource_servers ?? []);
  const exposed = items.some((r) => "proof_of_possession" in r);
  ctx.say(
    `CHECK DPoP / sender-constraining: Management API ${exposed ? "exposes" : "does NOT expose"} proof_of_possession on resource servers`,
  );
  if (!exposed)
    human.push(
      "The tenant's Management API does not expose proof_of_possession; DPoP may not be available on this plan/tenant. Verify in the dashboard.",
    );
  else
    ctx.say(
      "INFO  field exposure is necessary, not sufficient: entitlement is only confirmed when --apply succeeds (otherwise the script drops it and says so).",
    );
}

async function handleAlex(ctx, connection, orgId) {
  const { api, o, human } = ctx;
  const users = await api.get(
    `users?q=${enc(`name:"${ALEX_NAME}"`)}&search_engine=v3&per_page=10`,
  );
  let alex = (Array.isArray(users) ? users : []).find(
    (u) => u.name === ALEX_NAME,
  );
  ctx.say(
    `CHECK delegating user "${ALEX_NAME}": ${alex ? `found (${alex.user_id})` : "not found"}`,
  );
  if (!alex && o.createAlex) {
    if (connection.strategy !== "auth0")
      throw new ProvisionError(
        `--create-alex needs a database connection (strategy auth0); "${connection.name}" is ${connection.strategy}.`,
      );
    const password = `${randomBytes(18).toString("base64url")}aA1!`;
    ctx.scrubber.add(password);
    const r = await api.write(
      "POST",
      "users",
      {
        connection: connection.name,
        email: o.createAlex,
        password,
        email_verified: true,
        name: ALEX_NAME,
      },
      { owns: ALEX_NAME, sensitive: true },
    );
    alex = { user_id: r.json?.user_id, email: o.createAlex };
    ctx.state.alex = { user_id: alex.user_id, email: o.createAlex, password };
    ctx.save();
    ctx.record(
      `created user ${ALEX_NAME} in "${connection.name}" (password saved to the state file only)`,
    );
  }
  if (alex && orgId && !isPlanned(orgId) && !isPlanned(alex.user_id)) {
    const members = await api.list(
      `organizations/${enc(orgId)}/members`,
      "members",
      { perPage: 50 },
    );
    if (!members.some((m) => m.user_id === alex.user_id)) {
      if (ctx.state.alex?.user_id === alex.user_id || o.createAlex) {
        await api.write(
          "POST",
          `organizations/${enc(orgId)}/members`,
          { members: [alex.user_id] },
          { owns: ORG_NAME },
        );
        ctx.record(`added ${ALEX_NAME} to organization ${ORG_NAME}`);
      } else
        human.push(
          `${ALEX_NAME} exists but is not a member of ${ORG_NAME}; add it in the dashboard.`,
        );
    }
  }
  if (!alex && !o.createAlex)
    human.push(
      `Create the delegating user "${ALEX_NAME}" (re-run with --create-alex <email> to have the script create it in "${connection.name}"), and make it a member of ${ORG_NAME}.`,
    );
  human.push(
    `After put-secrets: run \`node demo/policy-desk/tools/alex-login.mjs\` once and sign in as ${ALEX_NAME} (${ctx.state.alex?.email ?? o.createAlex ?? "its email"}); it stores AGENT_OWNER_REFRESH_TOKEN directly as a Worker secret.`,
  );
}

function printHumanSection(ctx) {
  ctx.say("");
  ctx.say("ACTION NEEDED BY HUMAN");
  const manual = [
    ...ctx.human,
    "Create the Auth0 FGA store, write auth0/service/fga/model.fga, and set FGA_API_URL / FGA_STORE_ID vars and FGA_API_TOKEN / FGA_ADMIN_TOKEN secrets.",
    "Create the Postgres database + Cloudflare Hyperdrive config and put its id in wrangler.jsonc.",
    "Set the Cloudflare secrets listed in the vars file (`wrangler secret put <NAME>`; values are in the state file).",
    "Review the post-login before/after list above, especially how existing Actions interact with the two new ones.",
  ];
  manual.forEach((m, i) => ctx.say(` ${i + 1}. ${m}`));
  ctx.notes.forEach((n) => ctx.say(n));
}

async function destroyAll(ctx) {
  const { api, o } = ctx;
  const removed = [];
  const del = async (path, name) => {
    await api.write("DELETE", path, undefined, { owns: name });
    ctx.record(`deleted ${name}`);
    removed.push(name);
  };
  // 1. Unbind our Actions, keeping every other binding in place and in order.
  const existing = await api.list(
    "actions/triggers/post-login/bindings",
    "bindings",
    { totals: false },
  );
  const ours = existing.filter((b) => isOwnedName(b.action?.name));
  if (ours.length) {
    const keep = existing.filter((b) => !isOwnedName(b.action?.name));
    const payload = keep.map((b) => ({
      ref: { type: "binding_id", value: b.id },
      display_name: b.display_name,
    }));
    assertBindingsPreserved(
      existing,
      payload,
      ours.map((b) => b.action.name),
    );
    ctx.say("post-login flow BEFORE:");
    existing.forEach((b, i) => ctx.say(`  ${i + 1}. ${describeBinding(b)}`));
    ctx.say("post-login flow AFTER:");
    keep.forEach((b, i) => ctx.say(`  ${i + 1}. ${describeBinding(b)}`));
    await api.write(
      "PATCH",
      "actions/triggers/post-login/bindings",
      { bindings: payload },
      { owns: "policy-desk flow bindings (remove ours only)" },
    );
    ctx.record("removed Policy Desk Actions from the post-login flow");
  }
  // 2. Actions
  for (const spec of ACTIONS) {
    const found = (
      await api.list(
        `actions/actions?actionName=${enc(spec.name)}`,
        "actions",
        { perPage: 100, totals: false },
      )
    ).find((a) => a.name === spec.name);
    if (found)
      await del(`actions/actions/${enc(found.id)}?force=true`, found.name);
  }
  // 3. Alex
  const alexId = ctx.state.alex?.user_id;
  if (alexId) {
    const u = await api.get(`users/${enc(alexId)}`, { allow404: true });
    if (u?.name === ALEX_NAME) await del(`users/${enc(alexId)}`, u.name);
  }
  // 4. Clients (their grants go with them)
  const all = await api.list(
    "clients?fields=client_id,name&include_fields=true",
    "clients",
  );
  for (const c of [
    SPA_NAME,
    AGENT_OWNER.name,
    ...Object.values(M2M).map((m) => m.name),
  ]) {
    const hit = all.find((x) => x.name === c);
    if (hit) await del(`clients/${enc(hit.client_id)}`, hit.name);
  }
  // 5. Organization (the connection itself is untouched)
  const org = await api.get(`organizations/name/${enc(ORG_NAME)}`, {
    allow404: true,
  });
  if (org) await del(`organizations/${enc(org.id)}`, org.name);
  // 6. API
  const rs = await api.get(`resource-servers/${enc(ctx.audience)}`, {
    allow404: true,
  });
  if (rs) {
    assertOwnedName(rs.name, `API ${ctx.audience}`);
    await del(`resource-servers/${enc(rs.id)}`, rs.name);
  }
  if (!removed.length && !ours.length)
    ctx.say("Nothing to remove: no policy-desk objects found.");
  if (o.apply) {
    for (const f of [o.state, o.varsOut]) if (existsSync(f)) unlinkSync(f);
    ctx.say("Removed the local state and vars files.");
  }
}

export function defaultDeps() {
  return {
    run: realRunner(),
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    readFile: (p) => readFileSync(p, "utf8"),
    repoRoot: REPO_ROOT,
    readState: (p) =>
      existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null,
    writeState(p, state) {
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      chmodSync(p, 0o600);
    },
    writeVars(p, vars) {
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, `${JSON.stringify(vars, null, 2)}\n`, { mode: 0o600 });
      chmodSync(p, 0o600);
    },
  };
}

const USAGE = `Usage: node demo/policy-desk/tools/provision.mjs --tenant <domain> --origin <https origin> --connection <name>
         [--apply] [--destroy [--apply]] [--create-alex <email>] [--state <path>] [--vars-out <path>]
Default is a dry run. --destroy is also a dry run until combined with --apply.`;

/** Entry point. Returns the process exit code. All side effects go through `deps`. */
export async function main(argv, depsIn = {}) {
  const deps = { ...defaultDeps(), ...depsIn };
  let ctx;
  try {
    const o = parseArgs(argv);
    if (o.help) {
      deps.out(USAGE);
      return 0;
    }
    assertOutsideRepo(o.state, deps.repoRoot);
    assertOutsideRepo(o.varsOut, deps.repoRoot);
    ctx = new Ctx(o, deps);
    const prior = deps.readState(o.state);
    if (prior) {
      if (prior.tenant && prior.tenant !== o.tenant)
        throw new ProvisionError(
          `State file ${o.state} belongs to tenant ${prior.tenant}, not ${o.tenant}.`,
        );
      ctx.state = {
        ...ctx.state,
        ...prior,
        clients: prior.clients ?? {},
        actions: prior.actions ?? {},
      };
      secretsFromState(ctx.state, ctx.scrubber);
    }
    ctx.say(
      `${o.destroy ? "DESTROY" : "PROVISION"} ${o.apply ? "(APPLY)" : "(DRY RUN: nothing is written)"} tenant=${o.tenant} origin=${o.origin}`,
    );
    ctx.say(`state file: ${o.state}   vars file: ${o.varsOut}`);

    if (o.destroy) {
      await destroyAll(ctx);
      ctx.say(
        o.apply
          ? "Destroy complete."
          : "Dry run only. Add --apply together with --destroy to delete these objects.",
      );
      return 0;
    }

    const connection = await findConnection(ctx, o.connection);
    await runChecks(ctx, connection);
    await ensureResourceServer(ctx);
    const orgId = await ensureOrganization(ctx, connection);
    await ensureClients(ctx);
    const actions = await ensureActions(ctx);
    await bindActions(ctx, actions);
    await handleAlex(ctx, connection, orgId);

    const vars = buildVarsFile({
      domain: o.tenant,
      audience: ctx.audience,
      state: ctx.state,
    });
    if (o.apply) {
      deps.writeState(o.state, ctx.state);
      deps.writeVars(o.varsOut, vars);
      ctx.say(`wrote state (0600, contains secrets) -> ${o.state}`);
      ctx.say(`wrote non-secret Worker vars -> ${o.varsOut}`);
    } else {
      ctx.say(
        `would write state -> ${o.state} and Worker vars -> ${o.varsOut}`,
      );
      ctx.say(`Worker vars: ${JSON.stringify(vars.vars)}`);
    }
    printHumanSection(ctx);
    ctx.say(
      o.apply
        ? "Apply complete."
        : `Dry run complete (${ctx.created.length} change(s) planned). Re-run with --apply to perform them.`,
    );
    return 0;
  } catch (e) {
    const msg = ctx ? ctx.scrubber.scrub(e.message) : e.message;
    deps.err(`ERROR: ${msg}`);
    if (ctx?.created.length) {
      deps.err(`Already ${ctx.o.apply ? "done" : "planned"} before the error:`);
      ctx.created.forEach((l) => deps.err(`  - ${l}`));
      if (ctx.o.apply)
        deps.err(
          "Safe to re-run the same command: it looks objects up by name and continues. State so far is in the state file.",
        );
    }
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
