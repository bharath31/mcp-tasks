import {
  verifyCustomerAccessToken,
  verifiedCustomerAsHumanActor,
  type CustomerAccessTokenDeps,
} from "../../../shopping-merchant/src/identity/index.js";
import { shoppingIdentityConfigured } from "../../../shopping-merchant/src/identity/config.js";
import { SESSION_COOKIE, type ShoppingLiveEnv } from "./env.js";
import { customerStateRpc, customerStateStub } from "./customer-state-do.js";
import {
  randomBase64Url,
  signValue,
  verifySignedValue,
} from "./crypto-util.js";
import { secureCookieParts } from "./http.js";

export type AuthenticatedCustomer = {
  customerId: string;
  innerSid: string;
  human: ReturnType<typeof verifiedCustomerAsHumanActor>;
};

type CookieRecord = { customerId: string; sid: string };

function parseSessionCookie(req: Request): string | null {
  const match = req.headers
    .get("cookie")
    ?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function decodeSessionCookie(
  env: ShoppingLiveEnv,
  signed: string,
): Promise<CookieRecord | null> {
  const secret = env.SHOPPING_SESSION_SECRET;
  if (!secret) return null;
  const json = await verifySignedValue(secret, signed);
  if (!json) return null;
  try {
    const record = JSON.parse(json) as CookieRecord;
    if (!record.customerId || !record.sid) return null;
    return record;
  } catch {
    return null;
  }
}

export async function resolveCustomerSession(
  req: Request,
  env: ShoppingLiveEnv,
  deps: CustomerAccessTokenDeps = {},
): Promise<AuthenticatedCustomer | null> {
  const signed = parseSessionCookie(req);
  if (!signed || !shoppingIdentityConfigured(env) || !env.CUSTOMER_STATE) {
    return null;
  }
  const record = await decodeSessionCookie(env, signed);
  if (!record) return null;

  const stub = customerStateStub(env, record.customerId);
  await customerStateRpc(stub, record.customerId, {
    op: "bindCustomer",
    customerId: record.customerId,
  });
  const tokenRes = await customerStateRpc(stub, record.customerId, {
    op: "getSession",
    sid: record.sid,
  });
  if (!tokenRes.ok) return null;
  const tokenBody = (await tokenRes.json()) as { accessToken?: string };
  if (!tokenBody.accessToken) return null;

  const verified = await verifyCustomerAccessToken(
    env,
    tokenBody.accessToken,
    deps,
  );
  if (!verified || verified.customerId !== record.customerId) return null;

  return {
    customerId: verified.customerId,
    innerSid: record.sid,
    human: verifiedCustomerAsHumanActor(verified),
  };
}

export async function mintSessionCookie(
  env: ShoppingLiveEnv,
  customerId: string,
  accessToken: string,
  expiresAtMs: number,
  origin: string,
): Promise<string> {
  const secret = env.SHOPPING_SESSION_SECRET;
  if (!secret) throw new Error("session_secret_missing");
  const innerSid = randomBase64Url(32);
  const signed = await signValue(
    secret,
    JSON.stringify({ customerId, sid: innerSid }),
  );
  const stub = customerStateStub(env, customerId);
  await customerStateRpc(stub, customerId, {
    op: "bindCustomer",
    customerId,
  });
  const created = await customerStateRpc(stub, customerId, {
    op: "createSession",
    sid: innerSid,
    accessToken,
    expiresAtMs,
  });
  if (!created.ok) throw new Error("session_create_failed");
  const maxAge = Math.max(60, Math.floor((expiresAtMs - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(signed)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookieParts(origin)}`;
}

export async function clearSessionCookie(
  env: ShoppingLiveEnv,
  req: Request,
  origin: string,
  deps: CustomerAccessTokenDeps = {},
): Promise<{ clearCookie: string; customerId?: string }> {
  const session = await resolveCustomerSession(req, env, deps);
  if (session) {
    const stub = customerStateStub(env, session.customerId);
    await customerStateRpc(stub, session.customerId, {
      op: "revokeSession",
      sid: session.innerSid,
    });
  }
  const clearCookie = `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookieParts(origin)}`;
  return { clearCookie, customerId: session?.customerId };
}
