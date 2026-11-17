import { browserShoppingActor } from "../../src/actor.js";
import {
  customerStateRpc,
  customerStateStub,
} from "../../src/customer-state-do.js";
import type { ShoppingLiveEnv } from "../../src/env.js";
import { json, problem } from "../../src/http.js";
import { merchantLedgerRpc } from "../../src/merchant-client.js";

/** Test harness only — not reachable from the production Worker entry. */
export async function handleTestExpireQuote(
  req: Request,
  env: ShoppingLiveEnv,
): Promise<Response> {
  if (env.SHOPPING_LEDGER_TEST_HOOKS !== "1") {
    return problem(403, "forbidden", "Test quote expiry is disabled.");
  }
  const body = (await req.json().catch(() => null)) as {
    customerId?: string;
    quoteId?: string;
    expiresAt?: string;
  } | null;
  if (!body?.customerId || !body.quoteId || !body.expiresAt) {
    return problem(
      400,
      "invalid_body",
      "customerId, quoteId, and expiresAt are required.",
    );
  }
  const stub = customerStateStub(env, body.customerId);
  const sessionRes = await customerStateRpc(stub, body.customerId, {
    op: "getBrowserSessionId",
  });
  const sessionBody = (await sessionRes.json()) as { browserSessionId?: string };
  if (!sessionBody.browserSessionId) {
    return problem(404, "browser_session_missing", "Browser session not found.");
  }
  const actor = browserShoppingActor(
    env,
    body.customerId,
    sessionBody.browserSessionId,
  );
  const updated = await merchantLedgerRpc(env, body.customerId, {
    op: "setQuoteExpiresAtForTest",
    actor,
    quoteId: body.quoteId,
    expiresAt: body.expiresAt,
  });
  if (!updated.ok) {
    const err = (await updated.json().catch(() => ({}))) as { error?: string };
    return problem(409, "expire_failed", err.error ?? "expire_failed");
  }
  return json({ ok: true });
}