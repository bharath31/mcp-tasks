// Applies the Worker's migrations as the database OWNER, then (re)grants the
// least-privilege runtime role. Run this before deploying a Worker whose
// DATABASE_URL is the runtime role and whose MIGRATE_ON_REQUEST is "false":
//
//   OWNER_DATABASE_URL=postgres://... npx tsx demo/policy-desk/tools/migrate.ts
//
// The owner URL never goes into the Worker.
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { run, type Migration } from "../src/schema.js";

const SERVICE = new URL("../../../auth0/service/migrations/", import.meta.url);
const DESK = new URL("../src/migrations/", import.meta.url);

export function allMigrations(): Migration[] {
  return [
    ...readdirSync(SERVICE)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((name) => ({
        name,
        sql: readFileSync(new URL(name, SERVICE), "utf8"),
      })),
    ...readdirSync(DESK)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort()
      .map((f) => ({
        name: `policy-desk/${f}`,
        sql: readFileSync(new URL(f, DESK), "utf8"),
      })),
  ];
}

export const runtimeGrants = () =>
  readFileSync(new URL("runtime-grants.sql", DESK), "utf8");

export async function migrateAsOwner(connectionString: string) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await run(client, allMigrations());
    await client.query(runtimeGrants());
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.OWNER_DATABASE_URL;
  if (!url) {
    console.error(
      "Set OWNER_DATABASE_URL to the owner role's connection string.",
    );
    process.exit(2);
  }
  await migrateAsOwner(url);
  console.log("migrations applied; runtime grants refreshed");
}
