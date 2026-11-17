import {
  customerStateRpc,
  customerStateStub,
} from "../../src/customer-state-do.js";
import type { ShoppingLiveEnv } from "../../src/env.js";
import { json, problem } from "../../src/http.js";

export async function handleTestRevokeAgentCap(
  req: Request,
  env: ShoppingLiveEnv,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    customerId?: string;
    runId?: string;
  } | null;
  if (!body?.customerId || !body.runId) {
    return problem(400, "invalid_body", "customerId and runId are required.");
  }
  const stub = customerStateStub(env, body.customerId);
  await customerStateRpc(stub, body.customerId, {
    op: "revokeAgentCapability",
    runId: body.runId,
  });
  return json({ ok: true });
}
