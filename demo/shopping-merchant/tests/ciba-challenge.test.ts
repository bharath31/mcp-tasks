import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { GUARDIAN_PURCHASE_AUTHORIZATION_DETAILS_TYPE } from "../src/approval/constants.js";
import {
  consumeApprovedPurchaseCibaChallenge,
  pollPurchaseCibaChallenge,
  startPurchaseCibaChallenge,
  verifyCibaApprovalProof,
} from "../src/ciba/index.js";
import type { Quote } from "../src/types.js";
import { createMemoryCibaChallengeStore } from "./support/memory-ciba-challenge-store.js";
import {
  createMockShoppingCibaProvider,
  type MockShoppingCibaProvider,
} from "./support/mock-shopping-ciba-provider.js";
import { TEST_CUSTOMER, TEST_DOMAIN } from "./support/identity-jwt.js";

const MERCHANT = "Nominee Fixture Shop";

function fakeQuote(overrides: Partial<Quote> = {}): Quote {
  const base: Quote = {
    id: "quote-1",
    operationId: "op-1",
    revision: 1,
    cartId: "cart-1",
    cartVersion: 1,
    customerId: TEST_CUSTOMER,
    agentId: "agent-1",
    items: [
      {
        productId: "mug",
        name: "Mug",
        quantity: 1,
        priceMinor: 4300,
        currency: "USD",
      },
    ],
    subtotalMinor: 4300,
    taxMinor: 0,
    shippingMinor: 0,
    totalMinor: 4300,
    currency: "USD",
    destination: {
      id: "addr-1",
      customerId: TEST_CUSTOMER,
      label: "Home",
      version: "v1",
      trustedForAgentCheckout: true,
      destination: { country: "US" },
    },
    expiresAt: new Date("2099-06-01T00:00:00.000Z").toISOString(),
    requirement: "customer_verification",
  };
  return { ...base, ...overrides };
}

let mock: MockShoppingCibaProvider;
let nowMs = Date.parse("2098-01-01T00:00:00.000Z");
let challengeSeq = 0;

before(async () => {
  mock = await createMockShoppingCibaProvider();
});

function env() {
  const cibaDomain = new URL(mock.issuer).hostname;
  return {
    SHOPPING_AUTH0_DOMAIN: cibaDomain,
    SHOPPING_API_AUDIENCE: mock.audience,
    SHOPPING_CIBA_CLIENT_ID: "merchant-ciba",
    SHOPPING_CIBA_CLIENT_SECRET: "secret",
    SHOPPING_CIBA_BC_AUTHORIZE_URL: mock.bcAuthorizeUrl,
    SHOPPING_CIBA_TOKEN_URL: mock.tokenUrl,
  };
}

function coordinatorDeps(store = createMemoryCibaChallengeStore()) {
  return {
    env: env(),
    store,
    fetch: mock.fetch,
    testVerifyKey: mock.verifyKey,
    now: () => nowMs,
    id: () => `chal-${++challengeSeq}`,
  };
}

describe("shopping CIBA challenge coordinator (mock provider, memory store)", () => {
  test("starts polling and approves with top-level authorization_details", async () => {
    const store = createMemoryCibaChallengeStore();
    const deps = coordinatorDeps(store);
    const quote = fakeQuote();
    const started = await startPurchaseCibaChallenge(deps, {
      customerId: TEST_CUSTOMER,
      agentId: "agent-1",
      sessionId: "sess-1",
      quote,
      merchantDisplayName: MERCHANT,
      nowMs,
    });
    assert.equal(started.status, "pending");
    const row = await store.get(started.challengeId);
    assert.ok(row?.authReqId);
    assert.equal(row.status, "polling");

    const pending = await pollPurchaseCibaChallenge(deps, {
      challengeId: started.challengeId,
      quoteId: quote.id,
      quoteRevision: quote.revision,
      operationId: quote.operationId,
      customerId: TEST_CUSTOMER,
      agentId: "agent-1",
      sessionId: "sess-1",
    });
    assert.equal(pending.status, "pending");

    mock.decide(row.authReqId!, true);
    nowMs += 2_000;
    const approved = await pollPurchaseCibaChallenge(deps, {
      challengeId: started.challengeId,
      quoteId: quote.id,
      quoteRevision: quote.revision,
      operationId: quote.operationId,
      customerId: TEST_CUSTOMER,
      agentId: "agent-1",
      sessionId: "sess-1",
    });
    assert.equal(approved.status, "approved");
    const consumed = await consumeApprovedPurchaseCibaChallenge(
      store,
      started.challengeId,
      nowMs,
    );
    assert.equal(consumed, "consumed");
    const replayConsume = await consumeApprovedPurchaseCibaChallenge(
      store,
      started.challengeId,
      nowMs,
    );
    assert.equal(replayConsume, "unavailable");
  });

  test("rejects actor and term mismatches on poll", async () => {
    const deps = coordinatorDeps();
    const quote = fakeQuote();
    const started = await startPurchaseCibaChallenge(deps, {
      customerId: TEST_CUSTOMER,
      agentId: null,
      sessionId: null,
      quote,
      merchantDisplayName: MERCHANT,
      nowMs,
    });
    const badCustomer = await pollPurchaseCibaChallenge(deps, {
      challengeId: started.challengeId,
      quoteId: quote.id,
      quoteRevision: quote.revision,
      operationId: quote.operationId,
      customerId: "auth0|other",
      agentId: null,
      sessionId: null,
    });
    assert.equal(badCustomer.status, "unavailable");
    const badRevision = await pollPurchaseCibaChallenge(deps, {
      challengeId: started.challengeId,
      quoteId: quote.id,
      quoteRevision: 99,
      operationId: quote.operationId,
      customerId: TEST_CUSTOMER,
      agentId: null,
      sessionId: null,
    });
    assert.equal(badRevision.status, "unavailable");
  });

  test("rejects agent and session mismatches on poll", async () => {
    const deps = coordinatorDeps();
    const quote = fakeQuote();
    const started = await startPurchaseCibaChallenge(deps, {
      customerId: TEST_CUSTOMER,
      agentId: "agent-1",
      sessionId: "sess-1",
      quote,
      merchantDisplayName: MERCHANT,
      nowMs,
    });
    const badAgent = await pollPurchaseCibaChallenge(deps, {
      challengeId: started.challengeId,
      quoteId: quote.id,
      quoteRevision: quote.revision,
      operationId: quote.operationId,
      customerId: TEST_CUSTOMER,
      agentId: "agent-other",
      sessionId: "sess-1",
    });
    assert.equal(badAgent.status, "unavailable");
    const badSession = await pollPurchaseCibaChallenge(deps, {
      challengeId: started.challengeId,
      quoteId: quote.id,
      quoteRevision: quote.revision,
      operationId: quote.operationId,
      customerId: TEST_CUSTOMER,
      agentId: "agent-1",
      sessionId: "sess-other",
    });
    assert.equal(badSession.status, "unavailable");
  });

  test("records denial without fabricating approval", async () => {
    const store = createMemoryCibaChallengeStore();
    const deps = coordinatorDeps(store);
    const quote = fakeQuote();
    const started = await startPurchaseCibaChallenge(deps, {
      customerId: TEST_CUSTOMER,
      agentId: null,
      sessionId: null,
      quote,
      merchantDisplayName: MERCHANT,
      nowMs,
    });
    const row = (await store.get(started.challengeId))!;
    mock.decide(row.authReqId!, false);
    nowMs += 2_000;
    const denied = await pollPurchaseCibaChallenge(deps, {
      challengeId: started.challengeId,
      quoteId: quote.id,
      quoteRevision: quote.revision,
      operationId: quote.operationId,
      customerId: TEST_CUSTOMER,
      agentId: null,
      sessionId: null,
    });
    assert.equal(denied.status, "denied");
  });

  test("expired quote fails closed at proof verification", async () => {
    const detail = {
      type: GUARDIAN_PURCHASE_AUTHORIZATION_DETAILS_TYPE,
      instruction: "x",
      properties: {},
    };
    const quote = fakeQuote({
      expiresAt: new Date("2098-01-02T00:00:00.000Z").toISOString(),
    });
    const req = {
      authReqId: "expired-quote",
      customerSubject: TEST_CUSTOMER,
      authorizationDetails: [detail],
      status: "approved" as const,
    };
    const token = await mock.mintAccessToken(req);
    const pollNow = Date.parse("2098-01-03T00:00:00.000Z");
    await assert.rejects(
      () =>
        verifyCibaApprovalProof(
          {
            config: {
              bcAuthorizeUrl: mock.bcAuthorizeUrl,
              tokenUrl: mock.tokenUrl,
              clientId: "x",
              clientSecret: "y",
              issuer: mock.issuer,
              audience: mock.audience,
              jwksDomain: new URL(mock.issuer).hostname,
              timeoutMs: 5000,
            },
            testVerifyKey: mock.verifyKey,
          },
          {
            accessToken: token,
            topLevelAuthorizationDetails: [detail],
            expectedDetailsJson: JSON.stringify(detail),
            expectedCustomerId: TEST_CUSTOMER,
            quote,
            nowMs: pollNow,
          },
        ),
      (e: unknown) =>
        e instanceof Error &&
        e.name === "CibaProofRejected" &&
        "code" in e &&
        (e as { code: string }).code === "quote_expired",
    );
  });

  test("starting state without persisted auth_req_id stays unavailable", async () => {
    const store = createMemoryCibaChallengeStore();
    const quote = fakeQuote();
    await store.insertStarting({
      id: "stuck-start",
      status: "starting",
      customerId: TEST_CUSTOMER,
      agentId: null,
      sessionId: null,
      quoteId: quote.id,
      quoteRevision: quote.revision,
      operationId: quote.operationId,
      quoteExpiresAt: quote.expiresAt,
      quoteSnapshot: quote,
      canonicalAuthorizationDetailsJson: "{}",
      authReqId: null,
      pollIntervalSec: 5,
      nextPollAtMs: nowMs,
      challengeExpiresAtMs: nowMs + 60_000,
      createdAtMs: nowMs,
      decidedAtMs: null,
      consumedAtMs: null,
      failureCode: null,
    });
    const deps = coordinatorDeps(store);
    const result = await pollPurchaseCibaChallenge(deps, {
      challengeId: "stuck-start",
      quoteId: quote.id,
      quoteRevision: quote.revision,
      operationId: quote.operationId,
      customerId: TEST_CUSTOMER,
      agentId: null,
      sessionId: null,
    });
    assert.equal(result.status, "unavailable");
  });

  test("concurrent polls do not double-approve", async () => {
    const store = createMemoryCibaChallengeStore();
    const deps = coordinatorDeps(store);
    const quote = fakeQuote();
    const started = await startPurchaseCibaChallenge(deps, {
      customerId: TEST_CUSTOMER,
      agentId: null,
      sessionId: null,
      quote,
      merchantDisplayName: MERCHANT,
      nowMs,
    });
    const row = (await store.get(started.challengeId))!;
    mock.decide(row.authReqId!, true);
    nowMs += 2_000;
    const input = {
      challengeId: started.challengeId,
      quoteId: quote.id,
      quoteRevision: quote.revision,
      operationId: quote.operationId,
      customerId: TEST_CUSTOMER,
      agentId: null,
      sessionId: null,
    };
    const [a, b] = await Promise.all([
      pollPurchaseCibaChallenge(deps, input),
      pollPurchaseCibaChallenge(deps, input),
    ]);
    const approvedCount = [a.status, b.status].filter(
      (s) => s === "approved",
    ).length;
    assert.equal(approvedCount, 1);
  });

  test("verifyCibaApprovalProof accepts matching JWT-embedded authorization_details", async () => {
    const detail = {
      type: GUARDIAN_PURCHASE_AUTHORIZATION_DETAILS_TYPE,
      instruction: "x",
      properties: {},
    };
    const req = {
      authReqId: "jwt-also",
      customerSubject: TEST_CUSTOMER,
      authorizationDetails: [detail],
      status: "approved" as const,
      detailsInJwtAlso: true,
    };
    const token = await mock.mintAccessToken(req);
    await verifyCibaApprovalProof(
      {
        config: {
          bcAuthorizeUrl: mock.bcAuthorizeUrl,
          tokenUrl: mock.tokenUrl,
          clientId: "x",
          clientSecret: "y",
          issuer: mock.issuer,
          audience: mock.audience,
          jwksDomain: new URL(mock.issuer).hostname,
          timeoutMs: 5000,
        },
        testVerifyKey: mock.verifyKey,
      },
      {
        accessToken: token,
        topLevelAuthorizationDetails: [detail],
        expectedDetailsJson: JSON.stringify(detail),
        expectedCustomerId: TEST_CUSTOMER,
        quote: fakeQuote(),
        nowMs,
      },
    );
  });

  test("verifyCibaApprovalProof rejects inconsistent JWT authorization_details", async () => {
    const detail = {
      type: GUARDIAN_PURCHASE_AUTHORIZATION_DETAILS_TYPE,
      instruction: "x",
      properties: {},
    };
    const req = {
      authReqId: "jwt-mismatch",
      customerSubject: TEST_CUSTOMER,
      authorizationDetails: [detail],
      status: "approved" as const,
      detailsInJwtAlso: true,
      jwtDetailsMismatch: true,
    };
    const token = await mock.mintAccessToken(req);
    await assert.rejects(
      () =>
        verifyCibaApprovalProof(
          {
            config: {
              bcAuthorizeUrl: mock.bcAuthorizeUrl,
              tokenUrl: mock.tokenUrl,
              clientId: "x",
              clientSecret: "y",
              issuer: mock.issuer,
              audience: mock.audience,
              jwksDomain: new URL(mock.issuer).hostname,
              timeoutMs: 5000,
            },
            testVerifyKey: mock.verifyKey,
          },
          {
            accessToken: token,
            topLevelAuthorizationDetails: [detail],
            expectedDetailsJson: JSON.stringify(detail),
            expectedCustomerId: TEST_CUSTOMER,
            quote: fakeQuote(),
            nowMs,
          },
        ),
      (e: unknown) =>
        e instanceof Error &&
        e.name === "CibaProofRejected" &&
        "code" in e &&
        (e as { code: string }).code === "details_mismatch",
    );
  });

  test("missing top-level authorization_details fails closed at poll", async () => {
    const store = createMemoryCibaChallengeStore();
    const deps = coordinatorDeps(store);
    const quote = fakeQuote();
    const started = await startPurchaseCibaChallenge(deps, {
      customerId: TEST_CUSTOMER,
      agentId: null,
      sessionId: null,
      quote,
      merchantDisplayName: MERCHANT,
      nowMs,
    });
    const row = (await store.get(started.challengeId))!;
    const req = mock.requests.get(row.authReqId!)!;
    req.omitTopLevelDetails = true;
    mock.decide(row.authReqId!, true);
    nowMs += 2_000;
    const result = await pollPurchaseCibaChallenge(deps, {
      challengeId: started.challengeId,
      quoteId: quote.id,
      quoteRevision: quote.revision,
      operationId: quote.operationId,
      customerId: TEST_CUSTOMER,
      agentId: null,
      sessionId: null,
    });
    assert.equal(result.status, "unavailable");
    const after = await store.get(started.challengeId);
    assert.equal(after?.status, "uncertain");
  });
});
