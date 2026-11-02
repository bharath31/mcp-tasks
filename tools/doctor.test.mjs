import assert from "node:assert/strict";
import { test } from "node:test";
import { atLeast, main, maskUrl, parseArgs, parseVersion } from "./doctor.mjs";
import { CONTAINER, RUN_ARGS, main as dbUp } from "./db-up.mjs";

const SECRET_ENV = {
  OWNER_DATABASE_URL: "postgres://postgres:pw123@db.example.com:5432/postgres",
  FGA_STORE_ID: "01STORE",
  FGA_CLIENT_ID: "fga-client",
  FGA_CLIENT_SECRET: "fga-secret-value",
};

/** Everything healthy unless a test overrides it. */
function fakes(over = {}) {
  const lines = [];
  const calls = [];
  return {
    lines,
    calls,
    deps: {
      env: {},
      nodeVersion: "v22.12.0",
      exists: () => true,
      exec: async (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (cmd === "claude")
          return { code: 0, stdout: "2.1.310 (Claude Code)\n", stderr: "" };
        if (cmd === "npx")
          return {
            code: 0,
            stdout:
              "You are logged in with an OAuth Token, associated with the email dev@example.com.\n",
            stderr: "",
          };
        return { code: 0, stdout: "dev-x.us.auth0.com\n", stderr: "" };
      },
      pgPing: async () => ({ ok: true }),
      fetch: async () => new Response("{}", { status: 200 }),
      out: (l) => lines.push(l),
      ...over,
    },
  };
}

test("parseArgs: flags, https origin only, unknown arguments rejected", () => {
  assert.deepEqual(parseArgs([]), {
    deploy: false,
    url: undefined,
    help: false,
  });
  assert.equal(
    parseArgs(["--url", "https://x.workers.dev/some/path"]).url,
    "https://x.workers.dev",
  );
  assert.equal(parseArgs(["--deploy"]).deploy, true);
  assert.throws(() => parseArgs(["--url", "http://x.example"]), /https/);
  assert.throws(() => parseArgs(["--url"]), /needs a value/);
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});

test("version helpers", () => {
  assert.deepEqual(parseVersion("v2.1.304 (Claude Code)"), [2, 1, 304]);
  assert.equal(parseVersion("unknown"), null);
  assert.equal(atLeast([2, 1, 304], [2, 1, 304]), true);
  assert.equal(atLeast([2, 2, 0], [2, 1, 304]), true);
  assert.equal(atLeast([2, 1, 99], [2, 1, 304]), false);
  assert.equal(
    maskUrl(SECRET_ENV.OWNER_DATABASE_URL),
    "postgres://postgres:***@db.example.com:5432/postgres",
  );
});

test("default run checks only the local prerequisites and passes when they are met", async () => {
  const f = fakes();
  assert.equal(await main([], f.deps), 0);
  assert.deepEqual(f.calls, ["claude --version"]);
  assert.match(
    f.lines.join("\n"),
    /✓ Postgres: postgres:\/\/dogfood:\*\*\*@127\.0\.0\.1:55432/,
  );
  assert.match(f.lines.at(-1), /All required checks passed/);
});

test("a missing database or old Node fails with the fix; a missing Claude Code only warns", async () => {
  const f = fakes({
    nodeVersion: "v20.10.0",
    pgPing: async () => ({ ok: false, error: "connection refused" }),
    exec: async () => ({ code: 127, stdout: "", stderr: "ENOENT" }),
  });
  assert.equal(await main([], f.deps), 1);
  const out = f.lines.join("\n");
  assert.match(out, /✗ Node.js: v20.10.0, need 22/);
  assert.match(out, /✗ Postgres: .*connection refused\n\s+Run `npm run db:up`/);
  assert.match(out, /! Claude Code: not installed/);
  assert.match(out, /2 required checks failed/);
});

test("--deploy checks the CLIs and the setup environment without printing secrets", async () => {
  const f = fakes({ env: SECRET_ENV });
  assert.equal(await main(["--deploy"], f.deps), 0);
  const out = f.lines.join("\n");
  assert.ok(f.calls.includes("auth0 tenants list"));
  assert.ok(f.calls.includes("npx --no wrangler whoami"));
  assert.match(out, /✓ Wrangler: logged in as dev@example.com/);
  assert.doesNotMatch(out, /pw123|fga-secret-value/);
});

test("--deploy names each missing setup variable and a logged-out CLI", async () => {
  const f = fakes({
    env: { FGA_STORE_ID: "x" },
    exec: async (cmd) =>
      cmd === "auth0"
        ? { code: 1, stdout: "", stderr: "not logged in" }
        : { code: 0, stdout: "2.1.310", stderr: "" },
  });
  assert.equal(await main(["--deploy"], f.deps), 1);
  const out = f.lines.join("\n");
  assert.match(out, /✗ Auth0 CLI: not logged in/);
  assert.match(
    out,
    /✗ Setup environment: missing OWNER_DATABASE_URL, FGA_CLIENT_ID, FGA_CLIENT_SECRET/,
  );
  assert.match(out, /! Owner database: skipped/);
});

test("--url reports a Worker that has no database yet", async () => {
  const seen = [];
  const f = fakes({
    fetch: async (u) => {
      seen.push(u);
      return new Response("{}", { status: 503 });
    },
  });
  assert.equal(
    await main(["--url", "https://mcp-tasks.dev.workers.dev"], f.deps),
    1,
  );
  assert.deepEqual(seen, ["https://mcp-tasks.dev.workers.dev/healthz"]);
  assert.match(f.lines.join("\n"), /✗ \/healthz: 503\n\s+.*npm run setup/);
});

test("db:up creates the container once, then reuses it", async () => {
  const run = async (exists) => {
    const calls = [];
    let pings = 0;
    const code = await dbUp([], {
      docker: (args) => {
        calls.push(args);
        return {
          status: args[0] === "inspect" ? (exists ? 0 : 1) : 0,
          stderr: "",
        };
      },
      pgPing: async () => ({ ok: pings++ > 0 }),
      sleep: async () => {},
      out: () => {},
    });
    return { code, calls };
  };
  const fresh = await run(false);
  assert.equal(fresh.code, 0);
  assert.deepEqual(fresh.calls.at(-1), RUN_ARGS);
  const again = await run(true);
  assert.deepEqual(again.calls.at(-1), ["start", CONTAINER]);
});
