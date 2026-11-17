import type { SanitizedChallengeStatus } from "../../../shopping-merchant/src/ciba/challenge-types.js";
import { shoppingCibaConfigured } from "../../../shopping-merchant/src/ciba/config.js";
import { browserShoppingActor } from "./actor.js";
import { setActiveChallengeId } from "./checkout-session.js";
import { merchantLedgerRpc } from "./merchant-client.js";
import { customerStateRpc, customerStateStub } from "./customer-state-do.js";
import type { ShoppingLiveEnv } from "./env.js";
import type { AuthenticatedCustomer } from "./session.js";

export type ApprovalRecord = {
  id: string;
  quoteId: string;
  status: "pending" | "approved" | "denied" | "expired" | "failed";
  operationId: string;
  quoteRevision: number;
  /** Only set when the provider returned a validated review URL (CIBA push has none). */
  reviewUrl?: string;
  failureCode?: string;
  delivery: "guardian_push";
};

type StoredChallengeMeta = {
  quoteId: string;
  quoteRevision: number;
  operationId: string;
  status: string;
  failureCode?: string;
};

function mapStoredChallengeStatus(
  challengeId: string,
  meta: StoredChallengeMeta,
): ApprovalRecord {
  const pending = meta.status === "starting" || meta.status === "polling";
  let status: ApprovalRecord["status"];
  if (pending) status = "pending";
  else if (meta.status === "approved") status = "approved";
  else if (meta.status === "denied") status = "denied";
  else if (meta.status === "expired") status = "expired";
  else status = "failed";
  return {
    id: challengeId,
    quoteId: meta.quoteId,
    status,
    operationId: meta.operationId,
    quoteRevision: meta.quoteRevision,
    delivery: "guardian_push",
    ...(meta.failureCode ? { failureCode: meta.failureCode } : {}),
  };
}

function mapChallengeStatus(raw: SanitizedChallengeStatus): ApprovalRecord {
  const status =
    raw.status === "unavailable"
      ? ("failed" as const)
      : raw.status === "pending"
        ? ("pending" as const)
        : raw.status;
  return {
    id: raw.challengeId,
    quoteId: raw.quoteId,
    status,
    operationId: raw.operationId,
    quoteRevision: raw.quoteRevision,
    delivery: "guardian_push",
    ...(raw.failureCode ? { failureCode: raw.failureCode } : {}),
  };
}

async function persistChallengePointer(
  env: ShoppingLiveEnv,
  customerId: string,
  record: ApprovalRecord,
): Promise<void> {
  if (record.status === "pending" || record.status === "approved") {
    await setActiveChallengeId(env, customerId, record.id);
    return;
  }
  await setActiveChallengeId(env, customerId, null);
}

export async function browserSessionId(
  env: ShoppingLiveEnv,
  customerId: string,
): Promise<string> {
  const stub = customerStateStub(env, customerId);
  const res = await customerStateRpc(stub, customerId, {
    op: "getBrowserSessionId",
  });
  const body = (await res.json()) as { browserSessionId?: string };
  if (!body.browserSessionId) throw new Error("browser_session_missing");
  return body.browserSessionId;
}

export async function startCustomerApproval(
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
  quoteId: string,
): Promise<ApprovalRecord> {
  if (!shoppingCibaConfigured(env)) {
    throw new Error("ciba_unconfigured");
  }
  const trimmed = quoteId.trim();
  if (!trimmed) throw new Error("quote_id_required");
  const browserSession = await browserSessionId(env, customer.customerId);
  const actor = browserShoppingActor(env, customer.customerId, browserSession);
  const quoteRes = await merchantLedgerRpc(env, customer.customerId, {
    op: "getQuote",
    actor,
    quoteId: trimmed,
  });
  if (!quoteRes.ok) {
    const err = (await quoteRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "quote_unavailable");
  }
  const quote = (await quoteRes.json()) as {
    id: string;
    agentId: string | null;
  };
  const started = await merchantLedgerRpc(env, customer.customerId, {
    op: "startPurchaseCiba",
    actor: customer.human,
    quoteId: quote.id,
    browserSessionId: browserSession,
    agentId: quote.agentId,
  });
  if (!started.ok) {
    const err = (await started.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "approval_start_failed");
  }
  const raw = (await started.json()) as SanitizedChallengeStatus;
  if (!raw.challengeId) throw new Error("approval_start_failed");
  const record = mapChallengeStatus(raw);
  await persistChallengePointer(env, customer.customerId, record);
  return record;
}

export async function readCustomerApproval(
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
  challengeId: string,
): Promise<ApprovalRecord> {
  if (!shoppingCibaConfigured(env)) {
    throw new Error("ciba_unconfigured");
  }
  const trimmed = challengeId.trim();
  if (!trimmed) throw new Error("challenge_id_required");
  const metaRes = await merchantLedgerRpc(env, customer.customerId, {
    op: "getCibaChallenge",
    actor: customer.human,
    challengeId: trimmed,
  });
  if (!metaRes.ok) {
    const err = (await metaRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "challenge_not_found");
  }
  const meta = (await metaRes.json()) as StoredChallengeMeta;
  return mapStoredChallengeStatus(trimmed, meta);
}

export async function pollCustomerApproval(
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
  challengeId: string,
): Promise<ApprovalRecord> {
  if (!shoppingCibaConfigured(env)) {
    throw new Error("ciba_unconfigured");
  }
  const trimmed = challengeId.trim();
  if (!trimmed) throw new Error("challenge_id_required");
  const browserSession = await browserSessionId(env, customer.customerId);
  const metaRes = await merchantLedgerRpc(env, customer.customerId, {
    op: "getCibaChallenge",
    actor: customer.human,
    challengeId: trimmed,
  });
  if (!metaRes.ok) {
    const err = (await metaRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "challenge_not_found");
  }
  const meta = (await metaRes.json()) as {
    quoteId: string;
    quoteRevision: number;
    operationId: string;
    agentId: string | null;
    sessionId: string | null;
  };
  const sessionBinding = meta.sessionId ?? browserSession;
  const polled = await merchantLedgerRpc(env, customer.customerId, {
    op: "pollPurchaseCiba",
    actor: customer.human,
    challengeId: trimmed,
    quoteId: meta.quoteId,
    quoteRevision: meta.quoteRevision,
    operationId: meta.operationId,
    browserSessionId: sessionBinding,
    agentId: meta.agentId,
  });
  if (!polled.ok) {
    const err = (await polled.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "approval_poll_failed");
  }
  const raw = (await polled.json()) as SanitizedChallengeStatus;
  if (!raw.challengeId) throw new Error("approval_poll_failed");
  const record = mapChallengeStatus(raw);
  await persistChallengePointer(env, customer.customerId, record);
  return record;
}
