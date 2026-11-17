import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createNodeSqlDatabase } from "../src/sql.js";
import { initCibaChallengeSchema } from "../src/ciba/schema.js";
import { createSqlCibaChallengeStore } from "../src/ciba/sql-ciba-challenge-store.js";
import type { PurchaseCibaChallenge } from "../src/ciba/challenge-types.js";

function sampleChallenge(id: string, nowMs: number): PurchaseCibaChallenge {
  return {
    id,
    status: "starting",
    customerId: "cust-1",
    agentId: "agent-1",
    sessionId: "sess-1",
    quoteId: "quote-1",
    quoteRevision: 1,
    operationId: "op-1",
    quoteExpiresAt: new Date("2099-01-01T00:00:00.000Z").toISOString(),
    quoteSnapshot: {
      id: "quote-1",
      operationId: "op-1",
      revision: 1,
      cartId: "cart-1",
      cartVersion: 1,
      customerId: "cust-1",
      agentId: "agent-1",
      items: [],
      subtotalMinor: 100,
      taxMinor: 0,
      shippingMinor: 0,
      totalMinor: 100,
      currency: "USD",
      destination: {
        id: "a",
        customerId: "cust-1",
        label: "Home",
        version: "1",
        trustedForAgentCheckout: true,
        destination: { country: "US" },
      },
      expiresAt: new Date("2099-01-01T00:00:00.000Z").toISOString(),
      requirement: "customer_verification",
    },
    canonicalAuthorizationDetailsJson: "{}",
    authReqId: null,
    pollIntervalSec: 5,
    nextPollAtMs: nowMs,
    challengeExpiresAtMs: nowMs + 60_000,
    createdAtMs: nowMs,
    decidedAtMs: null,
    consumedAtMs: null,
    failureCode: null,
  };
}

test("Sql CIBA store persists approved row across SQLite restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ciba-store-"));
  const path = join(dir, "ciba.sqlite");
  const nowMs = 1_700_000_000_000;
  const id = "chal-restart";
  {
    const raw = new DatabaseSync(path);
    const db = createNodeSqlDatabase(raw);
    initCibaChallengeSchema(db);
    const store = createSqlCibaChallengeStore(db);
    await store.insertStarting(sampleChallenge(id, nowMs));
    await store.transition(id, ["starting"], "approved", {
      decidedAtMs: nowMs,
    });
    raw.close();
  }
  {
    const raw = new DatabaseSync(path);
    const db = createNodeSqlDatabase(raw);
    initCibaChallengeSchema(db);
    const store = createSqlCibaChallengeStore(db);
    const row = await store.get(id);
    assert.equal(row?.status, "approved");
    assert.equal(row?.agentId, "agent-1");
    assert.equal(row?.sessionId, "sess-1");
    raw.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test("Sql CIBA store concurrent consumeApproved has single winner", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = createNodeSqlDatabase(raw);
  initCibaChallengeSchema(db);
  const store = createSqlCibaChallengeStore(db);
  const nowMs = 1_700_000_000_000;
  const id = "chal-consume";
  await store.insertStarting(sampleChallenge(id, nowMs));
  await store.transition(id, ["starting"], "approved", { decidedAtMs: nowMs });
  const [a, b] = await Promise.all([
    store.consumeApproved(id, nowMs),
    store.consumeApproved(id, nowMs),
  ]);
  const wins = [a, b].filter((r) => r.ok);
  assert.equal(wins.length, 1);
  raw.close();
});
