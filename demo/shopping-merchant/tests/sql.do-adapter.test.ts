import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDoSqlDatabase,
  isSqlStorageNoRowError,
  type SqlDatabase,
} from "../src/sql.js";

test("isSqlStorageNoRowError recognizes absence-only cursor failures", () => {
  assert.equal(
    isSqlStorageNoRowError(new Error("Expected exactly one row")),
    true,
  );
  assert.equal(isSqlStorageNoRowError(new Error("SQLITE_CORRUPT")), false);
  assert.equal(isSqlStorageNoRowError("nope"), false);
});

function mockStorage(handlers: {
  one?: () => unknown;
  exec?: () => Iterable<unknown>;
}): DurableObjectStorage {
  const cursor = {
    one: handlers.one ?? (() => {
      throw new Error("Expected exactly one row");
    }),
    [Symbol.iterator]() {
      return (handlers.exec?.() ?? [])[Symbol.iterator]();
    },
  };
  return {
    sql: {
      exec: () => cursor,
    },
    transactionSync<T>(fn: () => T): T {
      return fn();
    },
  } as DurableObjectStorage;
}

test("createDoSqlDatabase cursor.one returns null only for no-row errors", () => {
  const absent = createDoSqlDatabase(mockStorage({}));
  assert.equal(absent.exec("SELECT 1").one(), null);

  const broken = createDoSqlDatabase(
    mockStorage({
      one: () => {
        throw new Error("SQLITE_BUSY: database locked");
      },
    }),
  );
  assert.throws(
    () => broken.exec("SELECT 1").one(),
    /SQLITE_BUSY/,
  );
});

test("createDoSqlDatabase uses transactionSync", () => {
  let ran = false;
  const db: SqlDatabase = createDoSqlDatabase(
    mockStorage({
      one: () => ({ n: 1 }),
    }),
  );
  db.transaction(() => {
    ran = true;
  });
  assert.equal(ran, true);
});