#!/usr/bin/env node
// Starts the local Postgres that the tests and the local stack use (127.0.0.1:55432), in Docker.
// Idempotent: reuses the container if it exists, and waits until the database answers.
//
//   npm run db:up      # start (or create) it
//   npm run db:down    # stop it; the data stays in the container
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { LOCAL_PG_URL, pgPing } from "./doctor.mjs";

export const CONTAINER = "mcp-tasks-postgres";
export const RUN_ARGS = [
  "run",
  "-d",
  "--name",
  CONTAINER,
  "-p",
  "55432:5432",
  "-e",
  "POSTGRES_USER=dogfood",
  "-e",
  "POSTGRES_PASSWORD=local-only",
  "-e",
  "POSTGRES_DB=postgres",
  "postgres:17-alpine",
];

const docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.error?.code === "ENOENT")
    throw new Error(
      "Docker is not installed. Install Docker Desktop, or point TEST_PG_ADMIN_URL at any Postgres 15+ you own.",
    );
  return r;
};

/** Entry point. Returns the process exit code. */
export async function main(
  argv,
  deps = {
    docker,
    pgPing,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: console.log,
  },
) {
  try {
    if (argv[0] === "down") {
      deps.docker(["stop", CONTAINER]);
      deps.out(`Stopped ${CONTAINER}.`);
      return 0;
    }
    if ((await deps.pgPing(LOCAL_PG_URL)).ok) {
      deps.out(`Postgres is already up on 127.0.0.1:55432.`);
      return 0;
    }
    const info = deps.docker(["info", "--format", "{{.ServerVersion}}"]);
    if (info.status !== 0) {
      deps.out(
        "Docker is installed but its daemon is not running. Start Docker Desktop (or `sudo systemctl start docker`) and re-run npm run db:up.",
      );
      return 1;
    }
    const exists = deps.docker(["inspect", CONTAINER]).status === 0;
    const r = deps.docker(exists ? ["start", CONTAINER] : RUN_ARGS);
    if (r.status !== 0) {
      deps.out(`docker ${exists ? "start" : "run"} failed:\n${r.stderr}`);
      if (/port is already allocated|address already in use/i.test(r.stderr))
        deps.out(
          "Something else holds port 55432. Stop it, or set TEST_PG_ADMIN_URL to that database.",
        );
      return 1;
    }
    for (let i = 0; i < 60; i++) {
      if ((await deps.pgPing(LOCAL_PG_URL)).ok) {
        deps.out(`Postgres is up on 127.0.0.1:55432 (container ${CONTAINER}).`);
        return 0;
      }
      await deps.sleep(500);
    }
    deps.out(
      "Postgres did not answer within 30 seconds. See `docker logs mcp-tasks-postgres`.",
    );
    return 1;
  } catch (e) {
    deps.out(`ERROR: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
