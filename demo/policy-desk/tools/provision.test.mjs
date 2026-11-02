// Tests for provision.mjs pure logic and orchestration against an in-memory fake `auth0` runner.
// No network, no real CLI. Run: node --test demo/policy-desk/tools/provision.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ACTIONS,
  Api,
  AGENT_OWNER,
  M2M,
  PERMISSIONS,
  REPO_ROOT,
  ProvisionError,
  appendBindings,
  assertBindingsPreserved,
  assertOutsideRepo,
  assertOwnedName,
  envNames,
  main,
  makeScrubber,
  parseArgs,
  parseCliError,
  parseCliJson,
  redact,
  secretValuesFromState,
} from "./provision.mjs";

const TENANT = "fake.us.auth0.com";
const ORIGIN = "https://mcp-tasks.bharath.sh";
const AUD = `${ORIGIN}/task-authority`;

// ---- fake Auth0 tenant ------------------------------------------------------------------
function makeFake(seed = {}) {
  let n = 0;
  const id = (p) => `${p}_${++n}`;
  const t = {
    resourceServers: [],
    orgs: [],
    orgConns: {},
    clients: [],
    grants: [],
    actions: [],
    bindings: [
      {
        id: "b1",
        display_name: "Restrict Email Domain",
        action: { id: "a1", name: "Restrict Email Domain" },
      },
      {
        id: "b2",
        display_name: "MFA gate",
        action: { id: "a2", name: "MFA gate" },
      },
    ],
    users: [],
    connections: [
      {
        id: "con_1",
        name: "login-db",
        strategy: "auth0",
        options: { disable_signup: true, secretish: "NOPE" },
      },
    ],
    factors: [
      { name: "otp", enabled: true },
      { name: "webauthn-roaming", enabled: false },
      { name: "webauthn-platform", enabled: false },
    ],
    writes: [],
    reads: [],
    rateLimitOnce: 0,
    failOn: null,
    ...seed,
  };
  const err = (status, message) => ({
    code: 1,
    stdout: "",
    stderr: `\n ▸    Agent mode on: JSON output\n\n=== x error\n\n ▸    ${status}: API request failed: ${JSON.stringify({ statusCode: status, message })}.\n`,
  });
  const ok = (json) => ({
    code: 0,
    stdout: json === undefined ? "" : JSON.stringify(json),
    stderr: " ▸    Agent mode on: JSON output, prompts and colors off.\n",
  });
  const page = (arr, key, q) => {
    const per = Number(q.get("per_page") ?? 50);
    const pg = Number(q.get("page") ?? 0);
    const items = arr.slice(pg * per, pg * per + per);
    return q.get("include_totals") === "true"
      ? { [key]: items, total: arr.length }
      : items;
  };
  const run = async (args, { input } = {}) => {
    assert.equal(args[0], "api");
    assert.ok(args.includes("--no-input"));
    assert.equal(args[args.indexOf("--tenant") + 1], TENANT);
    const method = args[1].toUpperCase();
    const url = new URL(`http://x/${args[2]}`);
    const path = url.pathname.slice(1);
    const q = url.searchParams;
    const di = args.indexOf("--data");
    const body =
      di >= 0
        ? JSON.parse(args[di + 1])
        : input
          ? JSON.parse(input)
          : undefined;
    if (method === "GET") t.reads.push(args[2]);
    else
      t.writes.push({
        method,
        path,
        body,
        viaStdin: di < 0 && input !== undefined,
      });
    if (t.rateLimitOnce > 0) {
      t.rateLimitOnce--;
      return err(429, "Too Many Requests");
    }
    if (t.failOn && t.failOn(method, path, body)) return err(500, "boom");
    let m;
    if (path === "guardian/factors") return ok(t.factors);
    if (path === "connections")
      return ok(
        page(
          t.connections.filter(
            (c) => !q.get("name") || c.name === q.get("name"),
          ),
          "connections",
          q,
        ),
      );
    if (path === "resource-servers" && method === "GET")
      return ok(page(t.resourceServers, "resource_servers", q));
    if (path === "resource-servers" && method === "POST") {
      const rs = { id: id("rs"), ...body };
      t.resourceServers.push(rs);
      return ok(rs);
    }
    if ((m = path.match(/^resource-servers\/(.+)$/))) {
      const key = decodeURIComponent(m[1]);
      const rs = t.resourceServers.find(
        (r) => r.identifier === key || r.id === key,
      );
      if (!rs) return err(404, "Not found");
      if (method === "GET") return ok(rs);
      if (method === "PATCH") return ok(Object.assign(rs, body));
      t.resourceServers = t.resourceServers.filter((r) => r !== rs);
      return ok();
    }
    if (path === "organizations" && method === "POST") {
      const o = { id: id("org"), ...body };
      t.orgs.push(o);
      t.orgConns[o.id] = [];
      return ok(o);
    }
    if ((m = path.match(/^organizations\/name\/(.+)$/))) {
      const o = t.orgs.find((x) => x.name === decodeURIComponent(m[1]));
      return o ? ok(o) : err(404, "No organization found by that id or name");
    }
    if (
      (m = path.match(
        /^organizations\/([^/]+)\/enabled_connections(?:\/(.+))?$/,
      ))
    ) {
      const list = t.orgConns[m[1]];
      if (method === "GET") return ok(page(list, "enabled_connections", q));
      if (method === "POST") return ok(list.push({ ...body }) && body);
      return ok(
        Object.assign(
          list.find((c) => c.connection_id === m[2]),
          body,
        ),
      );
    }
    if ((m = path.match(/^organizations\/([^/]+)\/members$/))) {
      if (method === "POST") return ok();
      return ok(page([], "members", q));
    }
    if ((m = path.match(/^organizations\/([^/]+)$/)) && method === "DELETE") {
      t.orgs = t.orgs.filter((o) => o.id !== m[1]);
      return ok();
    }
    if (path === "clients" && method === "GET")
      return ok(
        page(
          t.clients.map(({ client_id, name }) => ({ client_id, name })),
          "clients",
          q,
        ),
      );
    if (path === "clients" && method === "POST") {
      const c = {
        client_id: id("cid"),
        ...(body.app_type === "spa"
          ? {}
          : { client_secret: `SECRET-${n}-xxxxxxxxxxxx` }),
        ...body,
      };
      t.clients.push(c);
      return ok(c);
    }
    if ((m = path.match(/^clients\/(.+)$/))) {
      const c = t.clients.find((x) => x.client_id === decodeURIComponent(m[1]));
      if (!c) return err(404, "Not found");
      if (method === "GET") return ok(c);
      if (method === "PATCH") return ok(Object.assign(c, body));
      t.clients = t.clients.filter((x) => x !== c);
      t.grants = t.grants.filter((g) => g.client_id !== c.client_id);
      return ok();
    }
    if (path === "client-grants" && method === "GET")
      return ok(
        page(
          t.grants.filter(
            (g) =>
              g.client_id === q.get("client_id") &&
              g.audience === q.get("audience"),
          ),
          "client_grants",
          q,
        ),
      );
    if (path === "client-grants" && method === "POST") {
      const g = { id: id("cgr"), ...body };
      t.grants.push(g);
      return ok(g);
    }
    if ((m = path.match(/^client-grants\/(.+)$/)))
      return ok(
        Object.assign(
          t.grants.find((g) => g.id === m[1]),
          body,
        ),
      );
    if (path === "actions/actions" && method === "GET")
      return ok(
        page(
          t.actions.filter(
            (a) => !q.get("actionName") || a.name === q.get("actionName"),
          ),
          "actions",
          q,
        ),
      );
    if (path === "actions/actions" && method === "POST") {
      const a = {
        id: id("act"),
        status: "built",
        all_changes_deployed: false,
        secrets: (body.secrets ?? []).map((s) => ({ name: s.name })),
        ...body,
      };
      delete a.secrets_values;
      a.secrets = (body.secrets ?? []).map((s) => ({ name: s.name }));
      t.actions.push(a);
      return ok(a);
    }
    if ((m = path.match(/^actions\/actions\/([^/]+)\/deploy$/))) {
      t.actions.find((a) => a.id === m[1]).all_changes_deployed = true;
      return ok({});
    }
    if ((m = path.match(/^actions\/actions\/([^/]+)$/))) {
      const a = t.actions.find((x) => x.id === m[1]);
      if (method === "GET") return ok(a);
      if (method === "PATCH")
        return ok(Object.assign(a, body, { all_changes_deployed: false }));
      t.actions = t.actions.filter((x) => x !== a);
      return ok();
    }
    if (path === "actions/triggers/post-login/bindings") {
      if (method === "GET") return ok({ bindings: t.bindings });
      const next = body.bindings.map((b, i) => {
        if (b.ref.type === "binding_id")
          return t.bindings.find((x) => x.id === b.ref.value);
        const a = t.actions.find((x) => x.id === b.ref.value);
        return {
          id: `nb${i}`,
          display_name: b.display_name,
          action: { id: a.id, name: a.name },
        };
      });
      t.bindings = next;
      return ok({ bindings: next });
    }
    if (path === "users" && method === "GET") return ok(t.users);
    if (path === "users" && method === "POST") {
      const u = { user_id: `auth0|${id("u")}`, ...body };
      t.users.push(u);
      return ok(u);
    }
    if ((m = path.match(/^users\/(.+)$/))) {
      const u = t.users.find((x) => x.user_id === decodeURIComponent(m[1]));
      if (!u) return err(404, "Not found");
      if (method === "GET") return ok(u);
      t.users = t.users.filter((x) => x !== u);
      return ok();
    }
    return err(404, `fake: no route ${method} ${path}`);
  };
  return { t, run };
}

function harness(seed, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pd-test-"));
  const fake = makeFake(seed);
  const lines = [];
  const errs = [];
  const files = {};
  const deps = {
    run: fake.run,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    sleep: async () => {},
    readFile: (p) => `// content of ${p.split("/").pop()}\n`,
    repoRoot: REPO_ROOT,
    readState: () => files.state ?? null,
    writeState: (_p, s) => (files.state = JSON.parse(JSON.stringify(s))),
    writeVars: (_p, v) => (files.vars = v),
    ...overrides,
  };
  const base = [
    "--tenant",
    TENANT,
    "--origin",
    ORIGIN,
    "--connection",
    "login-db",
    "--state",
    join(dir, "state.json"),
    "--vars-out",
    join(dir, "vars.json"),
  ];
  return { fake, lines, errs, files, deps, base, dir };
}

// ---- pure logic -------------------------------------------------------------------------
test("name-prefix guard refuses non-owned objects", () => {
  assertOwnedName("policy-desk task-authority-approval");
  assertOwnedName("Policy Desk SPA");
  for (const bad of [
    "MCP Tasks MFA gate",
    "ta-demo-users",
    "Policy",
    "my policy-desk",
  ])
    assert.throws(() => assertOwnedName(bad), ProvisionError);
});

test("Api.write refuses unowned targets before any CLI call", async () => {
  let called = false;
  const api = new Api({
    run: async () => ((called = true), { code: 0, stdout: "{}", stderr: "" }),
    tenant: TENANT,
    dryRun: false,
  });
  await assert.rejects(
    api.write(
      "PATCH",
      "clients/abc",
      { name: "x" },
      { owns: "Some Other App" },
    ),
    /not named with the policy-desk/,
  );
  await assert.rejects(
    api.write("DELETE", "connections/c", undefined, {}),
    ProvisionError,
  );
  assert.equal(called, false);
});

test("appendBindings appends in order and preserves existing bindings", () => {
  const existing = [
    { id: "b1", display_name: "one", action: { id: "a1", name: "one" } },
    { id: "b2", display_name: "two", action: { id: "a2", name: "two" } },
  ];
  const wanted = [
    { id: "n1", name: "policy-desk task-authority-approval" },
    { id: "n2", name: "policy-desk task-authority-assurance" },
  ];
  const r = appendBindings(existing, wanted);
  assert.equal(r.changed, true);
  assert.deepEqual(
    r.payload.map((p) => [p.ref.type, p.ref.value]),
    [
      ["binding_id", "b1"],
      ["binding_id", "b2"],
      ["action_id", "n1"],
      ["action_id", "n2"],
    ],
  );
  assertBindingsPreserved(existing, r.payload);
  assert.equal(r.after.length, 4);
  assert.match(r.after[2], /\[NEW\]/);
});

test("appendBindings is a no-op when already bound, and only adds the missing one", () => {
  const wanted = [
    { id: "n1", name: "policy-desk a" },
    { id: "n2", name: "policy-desk b" },
  ];
  const both = [
    {
      id: "b1",
      display_name: "x",
      action: { id: "n1", name: "policy-desk a" },
    },
    {
      id: "b2",
      display_name: "y",
      action: { id: "n2", name: "policy-desk b" },
    },
  ];
  assert.equal(appendBindings(both, wanted).changed, false);
  const onlyFirst = both.slice(0, 1);
  const r = appendBindings(onlyFirst, wanted);
  assert.deepEqual(
    r.added.map((a) => a.id),
    ["n2"],
  );
});

test("appendBindings warns instead of appending an earlier action after a later one", () => {
  const wanted = [
    { id: "n1", name: "policy-desk a" },
    { id: "n2", name: "policy-desk b" },
  ];
  const onlySecond = [
    {
      id: "b9",
      display_name: "y",
      action: { id: "n2", name: "policy-desk b" },
    },
  ];
  const r = appendBindings(onlySecond, wanted);
  assert.equal(r.changed, false);
  assert.equal(r.warnings.length, 1);
});

test("assertBindingsPreserved rejects dropped, reordered, or interleaved bindings", () => {
  const existing = [
    { id: "b1", action: { name: "x" } },
    { id: "b2", action: { name: "y" } },
  ];
  const ref = (v) => ({
    ref: { type: "binding_id", value: v },
    display_name: v,
  });
  const neu = {
    ref: { type: "action_id", value: "n" },
    display_name: "policy-desk n",
  };
  assert.throws(
    () => assertBindingsPreserved(existing, [ref("b2"), ref("b1")]),
    /drop or reorder/,
  );
  assert.throws(
    () => assertBindingsPreserved(existing, [ref("b1")]),
    /drop or reorder/,
  );
  assert.throws(
    () => assertBindingsPreserved(existing, [ref("b1"), neu, ref("b2")]),
    /appended/,
  );
  assert.throws(
    () =>
      assertBindingsPreserved(existing, [
        ref("b1"),
        ref("b2"),
        { ...neu, display_name: "Other" },
      ]),
    /not named/,
  );
  assertBindingsPreserved(existing, [ref("b1"), ref("b2"), neu]);
  assertBindingsPreserved(existing, [ref("b1")], ["y"]);
});

test("redact hides secrets, action secret values and code, keeps the rest", () => {
  const out = redact({
    name: "n",
    client_secret: "abc",
    password: "pw",
    token_endpoint_auth_method: "none",
    refresh_token: { rotation_type: "rotating" },
    secrets: [{ name: "TASK_AUTHORITY_AUDIENCE", value: "https://x" }],
    code: "console.log('x')",
  });
  assert.equal(out.client_secret, "[REDACTED]");
  assert.equal(out.password, "[REDACTED]");
  assert.equal(out.token_endpoint_auth_method, "none");
  assert.equal(out.refresh_token.rotation_type, "rotating");
  assert.deepEqual(out.secrets, [
    { name: "TASK_AUTHORITY_AUDIENCE", value: "[REDACTED]" },
  ]);
  assert.match(out.code, /^\[\d+ chars sha256:/);
  const s = makeScrubber();
  s.add("supersecretvalue");
  assert.equal(s.scrub("x supersecretvalue y"), "x [REDACTED] y");
});

test("repo-path refusal", () => {
  assert.throws(
    () => assertOutsideRepo(join(REPO_ROOT, "state.json")),
    /inside the repository/,
  );
  assert.throws(
    () => assertOutsideRepo(join(REPO_ROOT, "demo", "new-dir", "s.json")),
    /inside the repository/,
  );
  assert.throws(() => assertOutsideRepo(REPO_ROOT), /inside the repository/);
  assertOutsideRepo(join(tmpdir(), "pd-ok", "state.json"));
});

test("parseArgs validates input and defaults to dry run", () => {
  const o = parseArgs(
    ["--tenant", TENANT, "--origin", `${ORIGIN}/`, "--connection", "c"],
    "/home/u",
  );
  assert.equal(o.apply, false);
  assert.equal(o.origin, ORIGIN);
  assert.equal(o.state, "/home/u/.policy-desk/auth0-state.json");
  assert.equal(o.varsOut, "/home/u/.policy-desk/wrangler-vars.json");
  assert.throws(
    () =>
      parseArgs([
        "--tenant",
        TENANT,
        "--origin",
        "http://x.com",
        "--connection",
        "c",
      ]),
    /https/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--tenant",
        TENANT,
        "--origin",
        `${ORIGIN}/path`,
        "--connection",
        "c",
      ]),
    /without a path/,
  );
  assert.throws(() => parseArgs(["--tenant", TENANT]), /--origin is required/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown/);
});

test("CLI output parsing ignores banners and extracts status", () => {
  assert.deepEqual(parseCliJson(' {"a":1}\n'), { a: 1 });
  assert.equal(parseCliJson(""), null);
  assert.throws(() => parseCliJson("Agent mode on"), ProvisionError);
  const e = parseCliError(
    '\n ▸    Agent mode on: x\n\n ▸    409: API request failed: {"statusCode":409,"message":"exists"}.\n',
  );
  assert.equal(e.status, 409);
  assert.equal(e.message, "exists");
});

test("Worker var and secret names match src/env.ts", () => {
  const env = readFileSync(
    join(REPO_ROOT, "demo/policy-desk/src/env.ts"),
    "utf8",
  );
  const { ids, secs } = envNames();
  for (const n of [
    ...ids,
    ...secs,
    "AUTH0_DOMAIN",
    "TASK_AUTHORITY_AUDIENCE",
    "SPA_CLIENT_ID",
    "AUTH0_ORG_ID",
    "AGENT_ID",
  ])
    assert.match(env, new RegExp(`\\b${n}\\?:`), `${n} missing from env.ts`);
});

// ---- orchestration against the fake tenant ---------------------------------------------
test("dry run performs no writes and shows the before/after flow", async () => {
  const h = harness();
  const code = await main(h.base, h.deps);
  assert.equal(code, 0, h.errs.join("\n"));
  assert.deepEqual(h.fake.t.writes, []);
  assert.equal(h.files.state, undefined);
  const text = h.lines.join("\n");
  assert.match(text, /PLAN POST resource-servers/);
  assert.match(text, /post-login flow BEFORE:/);
  assert.match(
    text,
    /post-login flow AFTER:[\s\S]*policy-desk task-authority-approval[\s\S]*assurance/,
  );
  assert.match(text, /ACTION NEEDED BY HUMAN/);
  assert.match(text, /Enable WebAuthn/);
  assert.match(text, /sign-up disabled/);
  assert.doesNotMatch(text, /secretish|NOPE/);
});

test("apply creates everything once, stays additive, and is idempotent on re-run", async () => {
  const h = harness();
  const before = JSON.parse(
    JSON.stringify({
      c: h.fake.t.connections,
      f: h.fake.t.factors,
      b: h.fake.t.bindings,
    }),
  );
  assert.equal(
    await main([...h.base, "--apply"], h.deps),
    0,
    h.errs.join("\n"),
  );
  const t = h.fake.t;
  // resource server
  const rs = t.resourceServers.find((r) => r.identifier === AUD);
  assert.equal(rs.name, "Policy Desk Task Authority");
  assert.equal(rs.token_dialect, "access_token_authz");
  assert.equal(rs.enforce_policies, true);
  assert.deepEqual(
    rs.scopes.map((s) => s.value).sort(),
    [...PERMISSIONS].sort(),
  );
  assert.deepEqual(rs.proof_of_possession.mechanism, "dpop");
  assert.deepEqual(rs.authorization_details, [
    { type: "task_authority_approval" },
  ]);
  // org + connection
  assert.equal(t.orgs.length, 1);
  assert.equal(t.orgs[0].name, "policy-desk");
  assert.equal(t.orgConns[t.orgs[0].id][0].assign_membership_on_login, true);
  // clients + grants
  assert.equal(t.clients.length, 8);
  const grantFor = (name) =>
    t.grants.find(
      (g) => g.client_id === t.clients.find((c) => c.name === name).client_id,
    );
  for (const m of Object.values(M2M))
    assert.deepEqual(
      grantFor(m.name).scope.slice().sort(),
      m.scopes.slice().sort(),
    );
  assert.deepEqual(grantFor("Policy Desk").scope, []);
  assert.deepEqual(M2M.admin.scopes, ["policies:write", "policies:read"]);
  assert.deepEqual(M2M.agent.scopes, []);
  const owner = t.clients.find((c) => c.name === AGENT_OWNER.name);
  assert.equal(owner.app_type, "regular_web");
  assert.deepEqual(owner.grant_types.sort(), [
    "authorization_code",
    "refresh_token",
  ]);
  assert.deepEqual(owner.callbacks, ["http://127.0.0.1:53682/callback"]);
  assert.equal(owner.organization_usage, "allow");
  assert.equal(owner.refresh_token.rotation_type, "non-rotating");
  const ownerGrant = t.grants.find((g) => g.client_id === owner.client_id);
  assert.deepEqual(ownerGrant.scope, []);
  assert.equal(ownerGrant.subject_type, "user");
  const spa = t.clients.find((c) => c.name === "Policy Desk");
  assert.equal(spa.organization_usage, "allow");
  assert.equal(spa.refresh_token.rotation_type, "rotating");
  assert.ok(
    spa.callbacks.includes(ORIGIN) &&
      spa.callbacks.includes(`${ORIGIN}/`) &&
      spa.callbacks.includes(`${ORIGIN}/review`) &&
      spa.callbacks.includes("http://localhost:8787"),
  );
  // actions
  assert.equal(t.actions.length, 2);
  assert.ok(
    t.actions.every(
      (a) =>
        a.all_changes_deployed &&
        a.runtime === "node22" &&
        a.supported_triggers[0].version === "v3",
    ),
  );
  assert.deepEqual(
    t.actions.find((a) => a.name.endsWith("assurance")).secrets,
    [{ name: "TASK_AUTHORITY_AUDIENCE" }],
  );
  // flow: existing preserved in order, ours appended
  assert.deepEqual(t.bindings.slice(0, 2), before.b);
  assert.deepEqual(
    t.bindings.slice(2).map((b) => b.action.name),
    ACTIONS.map((a) => a.name),
  );
  // nothing else touched
  assert.deepEqual(t.connections, before.c);
  assert.deepEqual(t.factors, before.f);
  for (const w of t.writes)
    assert.doesNotMatch(w.path, /^connections|guardian|tenants/);
  // state + vars
  assert.equal(Object.keys(h.files.state.clients).length, 8);
  assert.ok(h.files.state.clients.api.client_secret.startsWith("SECRET-"));
  assert.equal(h.files.vars.vars.AUTH0_DOMAIN, TENANT);
  assert.equal(h.files.vars.vars.SPA_CLIENT_ID, spa.client_id);
  assert.equal(h.files.vars.vars.AUTH0_ORG_ID, t.orgs[0].id);
  assert.ok(h.files.vars.secrets.includes("AGENT_CLIENT_SECRET"));
  assert.ok(h.files.vars.secrets.includes("AGENT_OWNER_CLIENT_SECRET"));
  assert.ok(h.files.vars.manualSecrets.includes("AGENT_OWNER_REFRESH_TOKEN"));
  const pushed = secretValuesFromState(h.files.state);
  assert.equal(pushed.AGENT_OWNER_CLIENT_ID, owner.client_id);
  assert.equal(pushed.AGENT_OWNER_CLIENT_SECRET, owner.client_secret);
  assert.doesNotMatch(JSON.stringify(h.files.vars), /SECRET-\d/);
  // stdout never has secrets
  assert.doesNotMatch(h.lines.join("\n"), /SECRET-\d/);
  assert.match(h.lines.join("\n"), /ACTION NEEDED BY HUMAN/);

  // second run: no writes at all
  const writesBefore = t.writes.length;
  assert.equal(
    await main([...h.base, "--apply"], h.deps),
    0,
    h.errs.join("\n"),
  );
  assert.equal(
    t.writes.length,
    writesBefore,
    JSON.stringify(t.writes.slice(writesBefore)),
  );
  assert.equal(t.bindings.length, 4);
});

test("refuses to adopt an API with our identifier that we do not own", async () => {
  const h = harness({
    resourceServers: [
      { id: "rs_x", identifier: AUD, name: "Someone Else's API", scopes: [] },
    ],
  });
  assert.equal(await main([...h.base, "--apply"], h.deps), 1);
  assert.match(h.errs.join("\n"), /not named with the policy-desk/);
  assert.deepEqual(h.fake.t.writes, []);
});

test("429 is retried with backoff; unexpected error stops and lists what was created", async () => {
  const h = harness({ rateLimitOnce: 2 });
  const delays = [];
  h.deps.sleep = async (ms) => delays.push(ms);
  assert.equal(
    await main([...h.base, "--apply"], h.deps),
    0,
    h.errs.join("\n"),
  );
  assert.deepEqual(delays.slice(0, 2), [1000, 2000]);

  const h2 = harness({ failOn: (m, p) => m === "POST" && p === "clients" });
  assert.equal(await main([...h2.base, "--apply"], h2.deps), 1);
  const e = h2.errs.join("\n");
  assert.match(e, /POST clients failed \(500\)/);
  assert.match(
    e,
    /Already done[\s\S]*created API Policy Desk Task Authority[\s\S]*created organization/,
  );
  assert.match(e, /Safe to re-run/);
  // the partial state is re-runnable
  h2.fake.t.failOn = null;
  assert.equal(
    await main([...h2.base, "--apply"], h2.deps),
    0,
    h2.errs.join("\n"),
  );
  assert.equal(h2.fake.t.resourceServers.length, 1);
  assert.equal(h2.fake.t.orgs.length, 1);
  assert.equal(h2.fake.t.clients.length, 8);
});

test("optional DPoP / RAR fields are dropped with a note when the tenant rejects them", async () => {
  const h = harness();
  const orig = h.deps.run;
  h.deps.run = async (args, o) => {
    const di = args.indexOf("--data");
    if (
      args[2] === "resource-servers" &&
      di >= 0 &&
      JSON.parse(args[di + 1]).authorization_details
    )
      return {
        code: 1,
        stdout: "",
        stderr:
          '400: API request failed: {"statusCode":400,"message":"authorization_details is not enabled for this tenant"}.',
      };
    return orig(args, o);
  };
  assert.equal(
    await main([...h.base, "--apply"], h.deps),
    0,
    h.errs.join("\n"),
  );
  const rs = h.fake.t.resourceServers[0];
  assert.equal(rs.authorization_details, undefined);
  assert.ok(rs.proof_of_possession);
  assert.match(h.lines.join("\n"), /rejected "authorization_details"/);
});

test("refuses state and vars paths inside the repo", async () => {
  const h = harness();
  const code = await main(
    [
      "--tenant",
      TENANT,
      "--origin",
      ORIGIN,
      "--connection",
      "login-db",
      "--state",
      join(REPO_ROOT, "state.json"),
    ],
    h.deps,
  );
  assert.equal(code, 1);
  assert.match(h.errs.join("\n"), /inside the repository/);
  assert.deepEqual(h.fake.t.reads, []);
});

test("destroy is a dry run without --apply, then removes only policy-desk objects", async () => {
  const h = harness();
  await main([...h.base, "--apply"], h.deps);
  const t = h.fake.t;
  t.clients.push({ client_id: "other", name: "Not Ours" });
  t.resourceServers.push({
    id: "rs_o",
    identifier: "https://other",
    name: "Other API",
    scopes: [],
  });
  const writes = t.writes.length;
  assert.equal(await main([...h.base, "--destroy"], h.deps), 0);
  assert.equal(t.writes.length, writes);
  assert.equal(
    await main([...h.base, "--destroy", "--apply"], h.deps),
    0,
    h.errs.join("\n"),
  );
  assert.deepEqual(
    t.clients.map((c) => c.name),
    ["Not Ours"],
  );
  assert.deepEqual(
    t.resourceServers.map((r) => r.name),
    ["Other API"],
  );
  assert.deepEqual(
    t.bindings.map((b) => b.id),
    ["b1", "b2"],
  );
  assert.equal(t.orgs.length, 0);
  assert.equal(t.actions.length, 0);
  assert.equal(t.connections.length, 1);
});

test("state file helper writes 0600 (real fs, temp dir outside repo)", async () => {
  const { defaultDeps } = await import("./provision.mjs");
  const dir = mkdtempSync(join(tmpdir(), "pd-mode-"));
  const p = join(dir, "sub", "s.json");
  defaultDeps().writeState(p, { a: 1 });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.ok(existsSync(p));
});

test("--create-alex sends the password over stdin, never prints it, and joins the organization", async () => {
  const h = harness();
  assert.equal(
    await main(
      [...h.base, "--apply", "--create-alex", "alex@example.com"],
      h.deps,
    ),
    0,
    h.errs.join("\n"),
  );
  const w = h.fake.t.writes.find((x) => x.path === "users");
  assert.equal(w.viaStdin, true);
  assert.equal(w.body.name, "policy-desk-alex");
  assert.equal(w.body.email_verified, true);
  assert.equal(w.body.connection, "login-db");
  const pw = h.files.state.alex.password;
  assert.ok(pw.length >= 20);
  assert.doesNotMatch(
    h.lines.join("\n") + h.errs.join("\n"),
    new RegExp(pw.replace(/[^a-zA-Z0-9]/g, ".")),
  );
  assert.doesNotMatch(
    JSON.stringify(h.files.vars),
    /alex@example.com|SECRET-\d/,
  );
  assert.match(h.lines.join("\n"), /alex-login\.mjs/);
  assert.ok(
    h.fake.t.writes.some((x) => /^organizations\/[^/]+\/members$/.test(x.path)),
  );
});

test("--create-alex is a dry run by default and Alex is deleted by --destroy --apply", async () => {
  const h = harness();
  assert.equal(
    await main([...h.base, "--create-alex", "alex@example.com"], h.deps),
    0,
  );
  assert.equal(h.fake.t.writes.length, 0);
  await main(
    [...h.base, "--apply", "--create-alex", "alex@example.com"],
    h.deps,
  );
  assert.equal(h.fake.t.users.length, 1);
  h.fake.t.users[0].name = "policy-desk-alex";
  const del = h.fake.t.writes.length;
  await main([...h.base, "--destroy", "--apply"], h.deps);
  assert.ok(
    h.fake.t.writes
      .slice(del)
      .some((x) => x.method === "DELETE" && /^users\//.test(x.path)),
  );
});

test("parseArgs validates --create-alex", () => {
  assert.throws(
    () =>
      parseArgs([
        "--tenant",
        TENANT,
        "--origin",
        ORIGIN,
        "--connection",
        "c",
        "--create-alex",
        "nope",
      ]),
    /email/,
  );
});
