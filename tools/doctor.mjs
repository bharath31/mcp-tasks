#!/usr/bin/env node
// Checks what you need before you run something, and says how to fix whatever is missing.
// Read-only: it never changes your machine, your tenant or your Worker.
//
//   npm run doctor                         # local stack and tests: Node, dependencies, Postgres
//   npm run doctor -- --deploy             # also: Auth0 CLI, Wrangler, and the setup environment
//   npm run doctor -- --url https://...    # also: a deployed Worker's /healthz
//
// Exits 1 when a required check fails. Secrets are checked for presence only, never printed.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_PG_URL =
  "postgres://dogfood:local-only@127.0.0.1:55432/postgres";
export const MIN_NODE = 22;
export const MIN_CLAUDE_CODE = "2.1.304";
export const SETUP_ENV = [
  "OWNER_DATABASE_URL",
  "FGA_STORE_ID",
  "FGA_CLIENT_ID",
  "FGA_CLIENT_SECRET",
];

const USAGE = `Usage: npm run doctor -- [--deploy] [--url <https origin>]
  (no flags)  Node, dependencies and Postgres for the local stack and the tests
  --deploy    also the Auth0 CLI, Wrangler and the environment npm run setup reads
  --url       also GET <origin>/healthz on a deployed Worker`;

export class DoctorError extends Error {}

export function parseArgs(argv) {
  const o = { deploy: false, url: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--deploy") o.deploy = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--url") {
      const v = argv[++i];
      if (!v || v.startsWith("--"))
        throw new DoctorError("--url needs a value");
      let u;
      try {
        u = new URL(v);
      } catch {
        throw new DoctorError(`--url is not a URL: ${v}`);
      }
      if (u.protocol !== "https:" && u.hostname !== "localhost")
        throw new DoctorError("--url must be an https origin");
      o.url = u.origin;
    } else throw new DoctorError(`Unknown argument: ${a}`);
  }
  return o;
}

/** "v2.1.310 (Claude Code)" -> [2, 1, 310]; null when no version is found. */
export function parseVersion(text) {
  const m = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

export function atLeast(have, want) {
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

/** Postgres URL with its password masked, for display. */
export function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(not a valid URL)";
  }
}

const ok = (name, detail) => ({ name, status: "ok", detail });
const fail = (name, detail, fix) => ({ name, status: "fail", detail, fix });
const warn = (name, detail, fix) => ({ name, status: "warn", detail, fix });

/**
 * Each group is a list of checks. A check returns ok, fail (required, sets the exit code) or warn
 * (optional: only some paths need it).
 */
export function checks(o, deps) {
  const { env } = deps;
  const pgUrl = env.TEST_PG_ADMIN_URL ?? LOCAL_PG_URL;
  const groups = [
    {
      title: "Local stack and tests",
      checks: [
        async () => {
          const v = parseVersion(deps.nodeVersion);
          return v && v[0] >= MIN_NODE
            ? ok("Node.js", deps.nodeVersion)
            : fail(
                "Node.js",
                `${deps.nodeVersion}, need ${MIN_NODE} or later`,
                "Install Node 22 (https://nodejs.org) or run `nvm use 22`.",
              );
        },
        async () =>
          deps.exists(join(REPO_ROOT, "node_modules", ".package-lock.json"))
            ? ok("Dependencies", "node_modules is installed")
            : fail("Dependencies", "not installed", "Run `npm ci`."),
        async () => {
          const r = await deps.pgPing(pgUrl);
          return r.ok
            ? ok("Postgres", maskUrl(pgUrl))
            : fail(
                "Postgres",
                `${maskUrl(pgUrl)}: ${r.error}`,
                env.TEST_PG_ADMIN_URL
                  ? "Start the database TEST_PG_ADMIN_URL points at, or unset it to use the local one."
                  : "Run `npm run db:up` (needs Docker), or point TEST_PG_ADMIN_URL at a Postgres you own.",
              );
        },
        async () => {
          const r = await deps.exec("claude", ["--version"]);
          if (r.code !== 0)
            return warn(
              "Claude Code",
              "not installed (only needed to drive the local stack from Claude Code)",
              "npm install -g @anthropic-ai/claude-code",
            );
          const v = parseVersion(r.stdout);
          return v && atLeast(v, parseVersion(MIN_CLAUDE_CODE))
            ? ok("Claude Code", r.stdout.trim())
            : warn(
                "Claude Code",
                `${r.stdout.trim()}: MCP Tasks need ${MIN_CLAUDE_CODE} or later`,
                "Run `claude update`.",
              );
        },
      ],
    },
  ];

  if (o.deploy)
    groups.push({
      title: "Deploy your own (npm run setup)",
      checks: [
        async () => {
          const r = await deps.exec("auth0", ["tenants", "list"]);
          if (r.code === 127)
            return fail(
              "Auth0 CLI",
              "not installed",
              "brew install auth0/auth0-cli/auth0 (or see https://github.com/auth0/auth0-cli#installation).",
            );
          return r.code === 0
            ? ok("Auth0 CLI", "logged in")
            : fail(
                "Auth0 CLI",
                "not logged in",
                "Run `npm run setup`: it opens the Auth0 login with the scopes it needs.",
              );
        },
        async () => {
          const r = await deps.exec("npx", ["--no", "wrangler", "whoami"]);
          const text = `${r.stdout}\n${r.stderr}`;
          if (r.code !== 0 || /not authenticated|not logged in/i.test(text))
            return fail(
              "Wrangler",
              "not logged in",
              "Run `npx wrangler login`.",
            );
          const email = text.match(/associated with the email\s+(\S+?)\.?\s/i);
          return ok(
            "Wrangler",
            email ? `logged in as ${email[1]}` : "logged in",
          );
        },
        async () => {
          const missing = SETUP_ENV.filter((k) => !env[k]);
          return missing.length === 0
            ? ok("Setup environment", SETUP_ENV.join(", "))
            : fail(
                "Setup environment",
                `missing ${missing.join(", ")}`,
                "`npm run setup` asks for them, or export them (docs/deploy-cloudflare.md, step 4). The FGA values come from the FGA dashboard, Settings > Create Client.",
              );
        },
        async () => {
          if (!env.OWNER_DATABASE_URL)
            return warn(
              "Owner database",
              "skipped: OWNER_DATABASE_URL is not set",
            );
          const r = await deps.pgPing(env.OWNER_DATABASE_URL);
          return r.ok
            ? ok("Owner database", maskUrl(env.OWNER_DATABASE_URL))
            : fail(
                "Owner database",
                `${maskUrl(env.OWNER_DATABASE_URL)}: ${r.error}`,
                "Use the owner connection string (on Supabase, the `postgres` user) and check its host, port and password.",
              );
        },
      ],
    });

  if (o.url)
    groups.push({
      title: `Deployed Worker (${o.url})`,
      checks: [
        async () => {
          try {
            const r = await deps.fetch(`${o.url}/healthz`, {
              signal: AbortSignal.timeout(10_000),
            });
            if (r.status === 200)
              return ok("/healthz", "200, database reachable");
            return fail(
              "/healthz",
              `${r.status}`,
              r.status === 503
                ? "The Worker has no working database yet: run `npm run setup` (docs/deploy-cloudflare.md, step 4)."
                : "Check the Worker's logs: `npx wrangler tail`.",
            );
          } catch (e) {
            return fail(
              "/healthz",
              `no answer: ${e?.cause?.code ?? e?.name ?? e}`,
              "Check the URL, and that the Worker is deployed (Cloudflare dashboard > Workers & Pages).",
            );
          }
        },
      ],
    });
  return groups;
}

/** Runs a command, capturing output. Never rejects; code 127 means the command was not found. */
function exec(cmd, args) {
  return new Promise((res) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ code: 127, stdout, stderr: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function pgPing(url) {
  let pg;
  try {
    pg = (await import("pg")).default;
  } catch {
    return { ok: false, error: "the pg package is not installed (run npm ci)" };
  }
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 3_000,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.query("select 1");
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error:
        e?.code === "ECONNREFUSED"
          ? "connection refused"
          : String(e?.message ?? e),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export function defaultDeps() {
  return {
    env: process.env,
    nodeVersion: process.version,
    exists: existsSync,
    exec,
    pgPing,
    fetch,
    out: (l) => process.stdout.write(`${l}\n`),
  };
}

const MARK = { ok: "✓", warn: "!", fail: "✗" };

/** Entry point. Returns the process exit code. */
export async function main(argv, depsIn = {}) {
  const deps = { ...defaultDeps(), ...depsIn };
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    deps.out(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    deps.out(USAGE);
    return 0;
  }
  let failed = 0;
  for (const group of checks(o, deps)) {
    deps.out(`\n${group.title}`);
    const results = await Promise.all(group.checks.map((c) => c()));
    for (const r of results) {
      deps.out(`  ${MARK[r.status]} ${r.name}: ${r.detail}`);
      if (r.fix && r.status !== "ok") deps.out(`      ${r.fix}`);
      if (r.status === "fail") failed++;
    }
  }
  deps.out(
    failed
      ? `\n${failed} required check${failed === 1 ? "" : "s"} failed. Fix ${failed === 1 ? "it" : "them"} and run npm run doctor again.`
      : "\nAll required checks passed.",
  );
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
