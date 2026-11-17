import {
  agentBrowserCsrfToken,
  encodeAgentCapabilityCookie,
  hashAgentCapabilitySecret,
  mintAgentCapabilitySecret,
} from "../../src/agent-capability.js";
import {
  customerStateRpc,
  customerStateStub,
} from "../../src/customer-state-do.js";
import type { ShoppingLiveEnv } from "../../src/env.js";
import { json, problem } from "../../src/http.js";

/** Test harness only — mints agent browser capability without exposing customer JWT to callers. */
export async function handleTestMintAgentCap(
  req: Request,
  env: ShoppingLiveEnv,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    customerId?: string;
    innerSid?: string;
    runId?: string;
  } | null;
  if (!body?.customerId || !body.innerSid) {
    return problem(
      400,
      "invalid_body",
      "customerId and innerSid are required.",
    );
  }
  const runId = body.runId ?? crypto.randomUUID();
  const secret = mintAgentCapabilitySecret();
  const digest = await hashAgentCapabilitySecret(
    body.customerId,
    runId,
    secret,
  );
  const stub = customerStateStub(env, body.customerId);
  await customerStateRpc(stub, body.customerId, {
    op: "bindCustomer",
    customerId: body.customerId,
  });
  await customerStateRpc(stub, body.customerId, {
    op: "putAgentCapability",
    runId,
    innerSid: body.innerSid,
    digest,
    expiresAtMs: Date.now() + 30 * 60_000,
  });
  const signed = await encodeAgentCapabilityCookie(env, {
    customerId: body.customerId,
    runId,
    secret,
  });
  return json({
    cookie: `nsh_agent_cap=${encodeURIComponent(signed)}`,
    csrfToken: await agentBrowserCsrfToken(env, runId, secret),
    runId,
  });
}
