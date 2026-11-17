import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_SESSION_SCOPES,
  AgentSessionConfigError,
  createAgentSessionService,
  MAX_AGENT_SESSION_TTL_MS,
  verifyCustomerAccessToken,
  verifiedCustomerAsHumanActor,
  type AgentSessionGrant,
  type AgentSessionStore,
} from "../src/identity/index.js";
import { createMemoryAgentSessionStore } from "./support/memory-agent-session-store.js";
import {
  mintCustomerAccessToken,
  shoppingTestJwks,
  testShoppingEnv,
  TEST_CUSTOMER,
} from "./support/identity-jwt.js";

const MERCHANT_AGENT = "https://agent.example/metadata";

function service(nowMs = () => Date.now()) {
  return createAgentSessionService({
    store: createMemoryAgentSessionStore(),
    merchantAgentId: MERCHANT_AGENT,
    ttlMs: 60_000,
    now: nowMs,
  });
}

async function verifiedHuman() {
  const token = await mintCustomerAccessToken();
  const jwks = await shoppingTestJwks();
  const v = await verifyCustomerAccessToken(testShoppingEnv, token, {
    testVerifyKey: jwks,
  });
  assert.ok(v);
  return verifiedCustomerAsHumanActor(v!);
}

test("grantSession ignores caller actor JSON and binds server ids + fixed scopes", async () => {
  const sessions = service();
  const customer = await verifiedHuman();
  const granted = await sessions.grantSession(customer);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  const actor = await sessions.verifyBearer(granted.bearer);
  assert.ok(actor);
  assert.equal(actor!.kind, "agent");
  if (actor!.kind !== "agent") return;
  assert.equal(actor.customerId, TEST_CUSTOMER);
  assert.equal(actor.agentId, MERCHANT_AGENT);
  assert.deepEqual(actor.scopes, [...AGENT_SESSION_SCOPES]);
  assert.ok(actor.sessionId.length > 10);
  assert.ok(actor.pairwiseUserId.length > 10);
  assert.ok(
    AGENT_SESSION_SCOPES.every((s) => actor.scopes.includes(s)),
    "missing bounded capabilities",
  );
  assert.ok(!(actor.scopes as string[]).includes("orders:read"));
  assert.ok(!(actor.scopes as string[]).includes("order:execute"));
});

test("verifyBearer fails closed on expiry, revocation, and tampering", async () => {
  let now = Date.now();
  const sessions = service(() => now);
  const customer = await verifiedHuman();
  const granted = await sessions.grantSession(customer);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  assert.ok(await sessions.verifyBearer(granted.bearer));

  assert.equal(await sessions.revokeBearer(granted.bearer), true);
  assert.equal(await sessions.revokeBearer(granted.bearer), false);
  assert.equal(await sessions.verifyBearer(granted.bearer), null);

  const granted2 = await sessions.grantSession(customer);
  assert.equal(granted2.ok, true);
  if (!granted2.ok) return;
  now += 61_000;
  assert.equal(await sessions.verifyBearer(granted2.bearer), null);

  assert.equal(await sessions.verifyBearer("not-a-bearer"), null);
  assert.equal(await sessions.verifyBearer("nsh_tampered"), null);
});

test("cross-customer: grant for one customer cannot authorize another", async () => {
  const sessions = service();
  const humanA = await verifiedHuman();
  const granted = await sessions.grantSession(humanA);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  const actor = await sessions.verifyBearer(granted.bearer);
  assert.ok(actor && actor.kind === "agent");
  assert.notEqual(actor!.customerId, "other-customer");
  assert.equal(actor!.customerId, TEST_CUSTOMER);
});

test("verifyBearer fails closed on corrupt stored grant scopes", async () => {
  let stored: AgentSessionGrant | undefined;
  const store: AgentSessionStore = {
    async put(_hash: string, grant: AgentSessionGrant) {
      stored = { ...grant };
      return true;
    },
    async get() {
      return stored ?? null;
    },
    async revoke() {
      return false;
    },
  };
  const sessions = createAgentSessionService({
    store,
    merchantAgentId: MERCHANT_AGENT,
    ttlMs: 60_000,
  });
  const granted = await sessions.grantSession(await verifiedHuman());
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  assert.ok(await sessions.verifyBearer(granted.bearer));
  stored = {
    ...stored!,
    scopes: [...AGENT_SESSION_SCOPES, "order:execute"],
  };
  assert.equal(await sessions.verifyBearer(granted.bearer), null);
});

test("grantSession requires verified human actor shape", async () => {
  const sessions = service();
  const bad = await sessions.grantSession({
    kind: "human",
    customerId: "",
    scopes: [],
  });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.reason, "invalid_customer");
});

test("createAgentSessionService rejects invalid merchantAgentId and TTL before persisting", async () => {
  const store = createMemoryAgentSessionStore();
  assert.throws(
    () =>
      createAgentSessionService({
        store,
        merchantAgentId: "   ",
        ttlMs: 60_000,
      }),
    AgentSessionConfigError,
  );
  for (const ttlMs of [0, -1, Infinity, NaN, MAX_AGENT_SESSION_TTL_MS + 1]) {
    assert.throws(
      () =>
        createAgentSessionService({
          store,
          merchantAgentId: MERCHANT_AGENT,
          ttlMs,
        }),
      AgentSessionConfigError,
    );
  }
});

test("revokeBearer applies the same bearer length bounds as verifyBearer", async () => {
  const sessions = service();
  assert.equal(await sessions.revokeBearer("nsh_short"), false);
  const huge = `${"nsh_"}${"a".repeat(600)}`;
  assert.equal(await sessions.revokeBearer(huge), false);
});

test("verifyBearer rejects stored grants with duplicate scope entries", async () => {
  let stored: AgentSessionGrant | undefined;
  const store: AgentSessionStore = {
    async put(_hash: string, grant: AgentSessionGrant) {
      stored = { ...grant };
      return true;
    },
    async get() {
      return stored ?? null;
    },
    async revoke() {
      return false;
    },
  };
  const sessions = createAgentSessionService({
    store,
    merchantAgentId: MERCHANT_AGENT,
    ttlMs: 60_000,
  });
  const granted = await sessions.grantSession(await verifiedHuman());
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  assert.ok(await sessions.verifyBearer(granted.bearer));
  stored = {
    ...stored!,
    scopes: ["cart:write", "cart:write", "addresses:read"],
  };
  assert.equal(await sessions.verifyBearer(granted.bearer), null);
});
