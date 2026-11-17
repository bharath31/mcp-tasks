import { buildGuardianPurchaseAuthorizationDetails } from "../approval/guardian-transaction-details.js";
import { validateQuoteForGuardianDetails } from "../approval/validate.js";
import {
  pollShoppingCibaToken,
  ShoppingCibaClientError,
  startShoppingCiba,
  type ShoppingCibaClientDeps,
} from "./client.js";
import { canonicalAuthorizationDetailsJson } from "./canonical.js";
import type { PurchaseCibaChallengeStore } from "./challenge-store.js";
import type {
  PurchaseCibaChallenge,
  SanitizedChallengeStatus,
  TrustedChallengeContext,
} from "./challenge-types.js";
import { normalizeShoppingCiba, type ShoppingCibaEnv } from "./config.js";
import {
  CibaProofRejected,
  verifyCibaApprovalProof,
  type CibaProofVerifierDeps,
} from "./verify.js";

export type ShoppingCibaCoordinatorDeps = {
  env: Partial<ShoppingCibaEnv>;
  store: PurchaseCibaChallengeStore;
  fetch?: typeof fetch;
  testVerifyKey?: CibaProofVerifierDeps["testVerifyKey"];
  /** Injectable clock for polls and expiry (defaults to Date.now). */
  now?: () => number;
  id?: () => string;
};

function sanitize(challenge: PurchaseCibaChallenge): SanitizedChallengeStatus {
  const pending =
    challenge.status === "starting" || challenge.status === "polling";
  let status: SanitizedChallengeStatus["status"];
  if (pending) status = "pending";
  else if (challenge.status === "approved") status = "approved";
  else if (challenge.status === "denied") status = "denied";
  else if (challenge.status === "expired") status = "expired";
  else status = "unavailable";
  const failureCode =
    status === "pending" || status === "approved"
      ? undefined
      : (challenge.failureCode ?? undefined);
  return {
    challengeId: challenge.id,
    status,
    quoteId: challenge.quoteId,
    operationId: challenge.operationId,
    quoteRevision: challenge.quoteRevision,
    ...(failureCode ? { failureCode } : {}),
  };
}

function assertTrustedContext(ctx: TrustedChallengeContext): void {
  if (ctx.quote.customerId !== ctx.customerId) {
    throw new Error("challenge_customer_mismatch");
  }
  if (ctx.agentId !== null && ctx.quote.agentId !== ctx.agentId) {
    throw new Error("challenge_agent_mismatch");
  }
}

export async function startPurchaseCibaChallenge(
  deps: ShoppingCibaCoordinatorDeps,
  ctx: TrustedChallengeContext,
): Promise<SanitizedChallengeStatus> {
  const config = normalizeShoppingCiba(deps.env);
  if (!config) {
    return {
      challengeId: "",
      status: "unavailable",
      quoteId: ctx.quote.id,
      operationId: ctx.quote.operationId,
      quoteRevision: ctx.quote.revision,
    };
  }
  assertTrustedContext(ctx);
  const nowMs = deps.now?.() ?? Date.now();
  validateQuoteForGuardianDetails(ctx.quote, nowMs);
  const details = buildGuardianPurchaseAuthorizationDetails({
    quote: ctx.quote,
    merchantDisplayName: ctx.merchantDisplayName,
    nowMs,
  });
  const canonicalJson = canonicalAuthorizationDetailsJson(details);
  const challengeId = deps.id?.() ?? crypto.randomUUID();
  const challenge: PurchaseCibaChallenge = {
    id: challengeId,
    status: "starting",
    customerId: ctx.customerId,
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    quoteId: ctx.quote.id,
    quoteRevision: ctx.quote.revision,
    operationId: ctx.quote.operationId,
    quoteExpiresAt: ctx.quote.expiresAt,
    quoteSnapshot: structuredClone(ctx.quote),
    canonicalAuthorizationDetailsJson: canonicalJson,
    authReqId: null,
    pollIntervalSec: 5,
    nextPollAtMs: nowMs,
    challengeExpiresAtMs: nowMs + 300_000,
    createdAtMs: nowMs,
    decidedAtMs: null,
    consumedAtMs: null,
    failureCode: null,
  };
  const inserted = await deps.store.insertStarting(challenge);
  if (!inserted) {
    throw new Error("challenge_id_collision");
  }
  const clientDeps: ShoppingCibaClientDeps = { config, fetch: deps.fetch };
  let started;
  try {
    started = await startShoppingCiba(clientDeps, {
      customerSubject: ctx.customerId,
      bindingMessage: `Approve purchase ${ctx.quote.operationId}`,
      authorizationDetails: [details],
      requestedExpirySec: 300,
    });
  } catch {
    await deps.store.transition(challengeId, ["starting"], "uncertain", {
      failureCode: "ciba_start_failed",
      decidedAtMs: nowMs,
    });
    return {
      challengeId,
      status: "unavailable",
      quoteId: ctx.quote.id,
      operationId: ctx.quote.operationId,
      quoteRevision: ctx.quote.revision,
    };
  }
  const providerExpiresAtMs = nowMs + started.expiresInSec * 1000;
  const quoteExpiryMs = Date.parse(ctx.quote.expiresAt);
  const challengeExpiresAtMs = Number.isFinite(quoteExpiryMs)
    ? Math.min(providerExpiresAtMs, quoteExpiryMs)
    : providerExpiresAtMs;
  const transitioned = await deps.store.transition(
    challengeId,
    ["starting"],
    "polling",
    {
      authReqId: started.authReqId,
      pollIntervalSec: started.intervalSec,
      nextPollAtMs: nowMs + started.intervalSec * 1000,
      challengeExpiresAtMs,
    },
  );
  if (!transitioned.ok) {
    await deps.store.transition(
      challengeId,
      ["starting", "polling"],
      "uncertain",
      {
        failureCode: "ciba_start_persist_failed",
        decidedAtMs: nowMs,
      },
    );
    return {
      challengeId,
      status: "unavailable",
      quoteId: ctx.quote.id,
      operationId: ctx.quote.operationId,
      quoteRevision: ctx.quote.revision,
    };
  }
  return sanitize(transitioned.challenge);
}

export type PollPurchaseCibaInput = {
  challengeId: string;
  /** Trusted quote binding re-check from host state. */
  quoteId: string;
  quoteRevision: number;
  operationId: string;
  customerId: string;
  /** Trusted host actor binding — must match values stored at challenge start. */
  agentId: string | null;
  sessionId: string | null;
};

export async function pollPurchaseCibaChallenge(
  deps: ShoppingCibaCoordinatorDeps,
  input: PollPurchaseCibaInput,
): Promise<SanitizedChallengeStatus> {
  const config = normalizeShoppingCiba(deps.env);
  const nowMs = deps.now?.() ?? Date.now();
  const existing = await deps.store.get(input.challengeId);
  if (!existing) {
    return {
      challengeId: input.challengeId,
      status: "unavailable",
      quoteId: input.quoteId,
      operationId: input.operationId,
      quoteRevision: input.quoteRevision,
    };
  }
  if (
    existing.quoteId !== input.quoteId ||
    existing.quoteRevision !== input.quoteRevision ||
    existing.operationId !== input.operationId ||
    existing.customerId !== input.customerId ||
    existing.agentId !== input.agentId ||
    existing.sessionId !== input.sessionId
  ) {
    return {
      challengeId: input.challengeId,
      status: "unavailable",
      quoteId: input.quoteId,
      operationId: input.operationId,
      quoteRevision: input.quoteRevision,
    };
  }
  if (existing.status === "approved") return sanitize(existing);
  if (existing.status === "denied" || existing.status === "expired") {
    return sanitize(existing);
  }
  if (existing.status === "starting" || existing.status === "uncertain") {
    return {
      challengeId: input.challengeId,
      status: "unavailable",
      quoteId: input.quoteId,
      operationId: input.operationId,
      quoteRevision: input.quoteRevision,
    };
  }
  if (existing.challengeExpiresAtMs <= nowMs) {
    await deps.store.transition(input.challengeId, ["polling"], "expired", {
      decidedAtMs: nowMs,
      failureCode: "challenge_expired",
    });
    const expired = (await deps.store.get(input.challengeId))!;
    return sanitize(expired);
  }
  if (nowMs < existing.nextPollAtMs) return sanitize(existing);
  const claimed = await deps.store.claimPoll(input.challengeId, nowMs);
  if (!claimed || !claimed.authReqId || !config) {
    return sanitize((await deps.store.get(input.challengeId)) ?? existing);
  }
  const clientDeps: ShoppingCibaClientDeps = { config, fetch: deps.fetch };
  let poll;
  try {
    poll = await pollShoppingCibaToken(clientDeps, claimed.authReqId);
  } catch (e) {
    if (e instanceof ShoppingCibaClientError) {
      await deps.store.transition(input.challengeId, ["polling"], "uncertain", {
        failureCode: e.code,
        decidedAtMs: nowMs,
      });
    }
    return {
      challengeId: input.challengeId,
      status: "unavailable",
      quoteId: input.quoteId,
      operationId: input.operationId,
      quoteRevision: input.quoteRevision,
    };
  }
  if (poll.state === "pending") {
    await deps.store.transition(input.challengeId, ["polling"], "polling", {
      nextPollAtMs: nowMs + claimed.pollIntervalSec * 1000,
    });
    return sanitize((await deps.store.get(input.challengeId))!);
  }
  if (poll.state === "slow_down") {
    await deps.store.transition(input.challengeId, ["polling"], "polling", {
      pollIntervalSec: poll.intervalSec,
      nextPollAtMs: nowMs + poll.intervalSec * 1000,
    });
    return sanitize((await deps.store.get(input.challengeId))!);
  }
  if (poll.state === "denied") {
    await deps.store.transition(input.challengeId, ["polling"], "denied", {
      decidedAtMs: nowMs,
      failureCode: "ciba_denied",
    });
    return sanitize((await deps.store.get(input.challengeId))!);
  }
  if (poll.state === "expired") {
    await deps.store.transition(input.challengeId, ["polling"], "expired", {
      decidedAtMs: nowMs,
      failureCode: "ciba_expired",
    });
    return sanitize((await deps.store.get(input.challengeId))!);
  }
  try {
    await verifyCibaApprovalProof(
      { config, testVerifyKey: deps.testVerifyKey, fetch: deps.fetch },
      {
        accessToken: poll.accessToken,
        topLevelAuthorizationDetails: poll.authorizationDetails,
        expectedDetailsJson: claimed.canonicalAuthorizationDetailsJson,
        expectedCustomerId: claimed.customerId,
        quote: claimed.quoteSnapshot,
        nowMs,
      },
    );
  } catch (e) {
    const code = e instanceof CibaProofRejected ? e.code : "invalid_token";
    await deps.store.transition(input.challengeId, ["polling"], "uncertain", {
      failureCode: code,
      decidedAtMs: nowMs,
    });
    return {
      challengeId: input.challengeId,
      status: "unavailable",
      quoteId: input.quoteId,
      operationId: input.operationId,
      quoteRevision: input.quoteRevision,
    };
  }
  const approved = await deps.store.transition(
    input.challengeId,
    ["polling"],
    "approved",
    { decidedAtMs: nowMs },
  );
  if (!approved.ok) {
    const cur = await deps.store.get(input.challengeId);
    return cur
      ? sanitize(cur)
      : {
          challengeId: input.challengeId,
          status: "unavailable",
          quoteId: input.quoteId,
          operationId: input.operationId,
          quoteRevision: input.quoteRevision,
        };
  }
  return sanitize(approved.challenge);
}

/**
 * Single-use consumption gate for coordinator-only flows (does not touch ledger).
 *
 * @deprecated For ledger integration use `recordApprovalWithConsumedChallenge` only.
 * Calling this before the ledger bridge sets `consumed_at_ms` and leaves the bridge with
 * `challenge_already_consumed` and no ledger approval.
 */
export async function consumeApprovedPurchaseCibaChallenge(
  store: PurchaseCibaChallengeStore,
  challengeId: string,
  nowMs: number = Date.now(),
): Promise<"consumed" | "unavailable"> {
  const result = await store.consumeApproved(challengeId, nowMs);
  return result.ok ? "consumed" : "unavailable";
}
