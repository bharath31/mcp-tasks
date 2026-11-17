import type { CustomerAccessTokenDeps } from "../../../../shopping-merchant/src/identity/customer-access-token.js";
import { verifyCustomerAccessToken } from "../../../../shopping-merchant/src/identity/index.js";
import { mintCustomerAccessToken } from "../../../../shopping-merchant/tests/support/identity-jwt.js";
import {
  customerStateRpc,
  customerStateStub,
} from "../../src/customer-state-do.js";
import { signValue } from "../../src/crypto-util.js";
import type { ShoppingLiveEnv } from "../../src/env.js";
import { json, problem } from "../../src/http.js";

/** Test harness only — not reachable from the production Worker entry. */
export async function handleTestSeedSession(
  req: Request,
  env: ShoppingLiveEnv,
  deps: CustomerAccessTokenDeps,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    customerId?: string;
    innerSid?: string;
    accessToken?: string;
  } | null;
  if (!body?.customerId) {
    return problem(400, "invalid_body", "customerId is required.");
  }
  const innerSid = body.innerSid ?? crypto.randomUUID().replace(/-/g, "");
  let accessToken = body.accessToken;
  if (!accessToken) {
    accessToken = await mintCustomerAccessToken({ sub: body.customerId });
  }
  const verified = await verifyCustomerAccessToken(env, accessToken, deps);
  if (!verified || verified.customerId !== body.customerId) {
    return problem(403, "token_rejected", "Access token failed verification.");
  }
  const stub = customerStateStub(env, body.customerId);
  await customerStateRpc(stub, body.customerId, {
    op: "bindCustomer",
    customerId: body.customerId,
  });
  await customerStateRpc(stub, body.customerId, {
    op: "createSession",
    sid: innerSid,
    accessToken,
    expiresAtMs: Date.now() + 3600_000,
  });
  const signed = await signValue(
    env.SHOPPING_SESSION_SECRET!,
    JSON.stringify({ customerId: body.customerId, sid: innerSid }),
  );
  return json({
    cookie: `nsh_sid=${encodeURIComponent(signed)}`,
    csrfToken: innerSid,
  });
}
