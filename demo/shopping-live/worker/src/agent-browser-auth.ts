import {
  agentBrowserCsrfMatches,
  agentBrowserCsrfToken,
  decodeAgentCapabilityCookie,
  hashAgentCapabilitySecret,
  parseAgentCapabilityCookie,
} from "./agent-capability.js";
import { customerStateRpc, customerStateStub } from "./customer-state-do.js";
import type { ShoppingLiveEnv } from "./env.js";
import { assertSameOrigin } from "./csrf.js";
import type { CustomerAccessTokenDeps } from "../../../shopping-merchant/src/identity/customer-access-token.js";
import {
  verifiedCustomerAsHumanActor,
  verifyCustomerAccessToken,
} from "../../../shopping-merchant/src/identity/index.js";
import type { AuthenticatedCustomer } from "./session.js";

export type VerifiedAgentBrowserContext = {
  customerId: string;
  runId: string;
  innerSid: string;
  csrfToken: string;
  capSecret: string;
};

export async function resolveAgentBrowserContext(
  req: Request,
  env: ShoppingLiveEnv,
): Promise<VerifiedAgentBrowserContext | null> {
  const blocked = assertSameOrigin(req, env);
  if (blocked) return null;
  const token = parseAgentCapabilityCookie(req);
  if (!token) return null;
  const payload = await decodeAgentCapabilityCookie(env, token);
  if (!payload) return null;
  const digest = await hashAgentCapabilitySecret(
    payload.customerId,
    payload.runId,
    payload.secret,
  );
  const stub = customerStateStub(env, payload.customerId);
  const verifyRes = await customerStateRpc(stub, payload.customerId, {
    op: "verifyAgentCapability",
    runId: payload.runId,
    digest,
  });
  if (!verifyRes.ok) return null;
  const body = (await verifyRes.json()) as {
    innerSid?: string;
    expiresAtMs?: number;
  };
  if (!body.innerSid) return null;
  if (typeof body.expiresAtMs === "number" && body.expiresAtMs <= Date.now()) {
    return null;
  }
  const sessionRes = await customerStateRpc(stub, payload.customerId, {
    op: "getSession",
    sid: body.innerSid,
  });
  if (!sessionRes.ok) return null;
  return {
    customerId: payload.customerId,
    runId: payload.runId,
    innerSid: body.innerSid,
    csrfToken: agentBrowserCsrfToken(payload.runId, payload.secret),
    capSecret: payload.secret,
  };
}

export function agentBrowserPostCsrfOk(
  ctx: VerifiedAgentBrowserContext,
  req: Request,
): boolean {
  const header =
    req.headers.get("x-nominee-agent-browser-csrf") ??
    req.headers.get("X-Nominee-Agent-Browser-Csrf");
  return agentBrowserCsrfMatches(ctx.runId, ctx.capSecret, header);
}

export async function agentBrowserAsCustomer(
  env: ShoppingLiveEnv,
  ctx: VerifiedAgentBrowserContext,
  deps: CustomerAccessTokenDeps = {},
): Promise<AuthenticatedCustomer | null> {
  const stub = customerStateStub(env, ctx.customerId);
  const sessionRes = await customerStateRpc(stub, ctx.customerId, {
    op: "getSession",
    sid: ctx.innerSid,
  });
  if (!sessionRes.ok) return null;
  const tokenBody = (await sessionRes.json()) as { accessToken?: string };
  if (!tokenBody.accessToken) return null;
  const verified = await verifyCustomerAccessToken(
    env,
    tokenBody.accessToken,
    deps,
  );
  if (!verified || verified.customerId !== ctx.customerId) return null;
  return {
    customerId: verified.customerId,
    innerSid: ctx.innerSid,
    human: verifiedCustomerAsHumanActor(verified),
  };
}
