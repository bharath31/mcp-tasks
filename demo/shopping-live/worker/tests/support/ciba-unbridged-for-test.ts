import {
  customerStateRpc,
  customerStateStub,
} from "../../src/customer-state-do.js";
import type { ShoppingLiveEnv } from "../../src/env.js";
import { json, problem } from "../../src/http.js";
import { merchantLedgerRpc } from "../../src/merchant-client.js";

/** Test harness only — simulates coordinator approval before the ledger bridge runs. */
export async function handleTestCibaUnbridged(
  req: Request,
  env: ShoppingLiveEnv,
): Promise<Response> {
  if (env.SHOPPING_LEDGER_TEST_HOOKS !== "1") {
    return problem(403, "forbidden", "Test CIBA hooks are disabled.");
  }
  const body = (await req.json().catch(() => null)) as {
    customerId?: string;
    challengeId?: string;
  } | null;
  if (!body?.customerId || !body.challengeId) {
    return problem(
      400,
      "invalid_body",
      "customerId and challengeId are required.",
    );
  }
  const stub = customerStateStub(env, body.customerId);
  const sessionRes = await customerStateRpc(stub, body.customerId, {
    op: "getBrowserSessionId",
  });
  const sessionBody = (await sessionRes.json()) as {
    browserSessionId?: string;
  };
  if (!sessionBody.browserSessionId) {
    return problem(
      404,
      "browser_session_missing",
      "Browser session not found.",
    );
  }
  const human = {
    kind: "human" as const,
    customerId: body.customerId,
    scopes: [] as string[],
  };
  const result = await merchantLedgerRpc(env, body.customerId, {
    op: "setCibaChallengeApprovedUnbridgedForTest",
    actor: human,
    challengeId: body.challengeId,
  });
  if (!result.ok) {
    const err = (await result.json().catch(() => ({}))) as { error?: string };
    return problem(409, "simulate_failed", err.error ?? "simulate_failed");
  }
  return json({ ok: true });
}
