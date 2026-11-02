import { randomBytes } from "node:crypto";
import pg from "pg";

export const ADMIN_URL =
  process.env.TEST_PG_ADMIN_URL ??
  "postgres://dogfood:local-only@127.0.0.1:55432/postgres";

/** A throwaway database so each test file gets an isolated service datastore. */
export async function createTestDb(prefix = "ta") {
  const name = `${prefix}_${randomBytes(5).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return {
    name,
    url: url.toString(),
    async drop() {
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
