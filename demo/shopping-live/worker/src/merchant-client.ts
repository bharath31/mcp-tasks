import {
  MERCHANT_HOST_INTERNAL_SECRET_HEADER,
  readHostInternalSecret,
} from "../../../shopping-merchant/src/port-env.js";
import type { TrustedActor } from "../../../shopping-merchant/src/types.js";
import type { ShoppingLiveEnv } from "./env.js";

export async function merchantLedgerRpc(
  env: ShoppingLiveEnv,
  customerId: string,
  body: Record<string, unknown> & { actor: TrustedActor },
): Promise<Response> {
  const secret = readHostInternalSecret(env);
  if (!secret || !env.MERCHANT_LEDGER) {
    return Response.json(
      {
        code: "merchant_unavailable",
        message: "Merchant ledger is not configured.",
      },
      { status: 503 },
    );
  }
  const id = env.MERCHANT_LEDGER.idFromName(customerId);
  const stub = env.MERCHANT_LEDGER.get(id);
  return stub.fetch("http://ledger/internal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nominee-customer-id": customerId,
      [MERCHANT_HOST_INTERNAL_SECRET_HEADER]: secret,
    },
    body: JSON.stringify(body),
  });
}