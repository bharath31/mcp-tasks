import type { ShoppingLiveEnv } from "../../src/env.js";
import { json } from "../../src/http.js";
import { merchantLedgerRpc } from "../../src/merchant-client.js";
import { TEST_CUSTOMER } from "../../../../shopping-merchant/tests/support/identity-jwt.js";

/** Harness-only — verifies deployable merchant DO rejects unsafe mutation RPC ops. */
export async function handleTestProbeForbiddenLedgerOps(
  _req: Request,
  env: ShoppingLiveEnv,
): Promise<Response> {
  const human = {
    kind: "human" as const,
    customerId: TEST_CUSTOMER,
    scopes: [] as string[],
  };
  const probes = [
    {
      op: "setQuoteExpiresAtForTest",
      body: {
        op: "setQuoteExpiresAtForTest",
        actor: human,
        quoteId: "q_missing",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    },
    {
      op: "setCibaChallengeApprovedUnbridgedForTest",
      body: {
        op: "setCibaChallengeApprovedUnbridgedForTest",
        actor: human,
        challengeId: "ch_missing",
      },
    },
    {
      op: "harnessSetQuoteExpiresAt",
      body: {
        op: "harnessSetQuoteExpiresAt",
        actor: human,
        quoteId: "q_missing",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    },
    {
      op: "harnessSetCibaChallengeApprovedUnbridged",
      body: {
        op: "harnessSetCibaChallengeApprovedUnbridged",
        actor: human,
        challengeId: "ch_missing",
      },
    },
  ] as const;

  const results: { op: string; status: number; error?: string }[] = [];
  for (const probe of probes) {
    const res = await merchantLedgerRpc(env, TEST_CUSTOMER, probe.body);
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    results.push({ op: probe.op, status: res.status, error: body.error });
  }
  return json({ results });
}
