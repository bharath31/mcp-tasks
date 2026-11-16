/** All inputs to these functions must come directly from server-side SDK calls. */
export type Actor =
  | { kind: "unauthenticated"; scopes: string[] }
  | { kind: "human"; customerId: string; scopes: string[] }
  | {
      kind: "guest-agent";
      agentId: string;
      pairwiseUserId: string;
      sessionId: string;
      scopes: string[];
    }
  | {
      kind: "signed-in-agent";
      agentId: string;
      pairwiseUserId: string;
      sessionId: string;
      customerId: string;
      scopes: string[];
    };

export type AgentResolver = (
  verifiedAgentId: string,
  source: "header" | "token" | "browser",
) => string | undefined;
type Claims = {
  sub?: string;
  scope?: unknown;
  act?: unknown;
  sub_profile?: unknown;
};
export interface VerifiedRequest {
  poppy?: {
    sessionId: string;
    userId: string;
    agent: { cimdUrl: string };
    state: "signed_in" | "signed_out";
    source: "header" | "token";
  };
  claims?: Claims;
}
export interface ApiClient {
  verifyPoppyRequest(options: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    requireSession?: boolean;
  }): Promise<VerifiedRequest>;
}
export type BrowserContext =
  | { kind: "human" }
  | {
      kind: "agent";
      state: "guest" | "signed_in";
      sub: string;
      act: { sub: string; poppy_sid: string; poppy_user_id: string };
      scopes: string[];
    };
export interface BrowserClient {
  poppy: { getContext(): Promise<BrowserContext> };
  getSession(): Promise<{ user: { sub?: string } } | null>;
}
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
function accepted(
  id: unknown,
  source: "header" | "token" | "browser",
  resolve: AgentResolver,
): string {
  if (!text(id)) throw new Error("Verified agent identity missing");
  const canonical = resolve(id, source);
  if (!text(canonical)) throw new Error("Verified agent is not accepted");
  return canonical;
}
function required(value: unknown, label: string): string {
  if (!text(value)) throw new Error(`Verified ${label} missing`);
  return value;
}
function scopes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(/\s+/).filter(Boolean);
}
export async function verifyApiRequest(
  client: ApiClient,
  request: Request,
  resolve: AgentResolver,
): Promise<Actor> {
  if (typeof client?.verifyPoppyRequest !== "function")
    throw new Error(
      "Poppy SDK unsupported: install a compatible build of auth0-api-js PR #342 with verifyPoppyRequest",
    );
  const hasHeader = request.headers.has("poppy-session");
  const result = await client.verifyPoppyRequest({
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers),
    requireSession: hasHeader,
  });
  if (!result || typeof result !== "object")
    throw new Error("Incompatible Poppy SDK verification result");
  if (!result.poppy) {
    if (hasHeader || result.claims?.act)
      throw new Error("Poppy session not verified");
    return { kind: "unauthenticated", scopes: [] };
  }
  const p = result.poppy;
  if (p.source !== "header" && p.source !== "token")
    throw new Error("Invalid verified session source");
  const base = {
    agentId: accepted(p.agent?.cimdUrl, p.source, resolve),
    pairwiseUserId: required(p.userId, "pairwise user"),
    sessionId: required(p.sessionId, "session"),
  };
  const guestToken =
    result.claims?.sub?.startsWith("anon_poppy@") ||
    (typeof result.claims?.sub_profile === "string" &&
      result.claims.sub_profile
        .split(/\s+/)
        .includes("urn:auth0:anonymous_user"));
  if (p.state === "signed_out" || guestToken)
    return { kind: "guest-agent", ...base, scopes: [] };
  if (p.state !== "signed_in")
    throw new Error("Invalid verified session state");
  return {
    kind: "signed-in-agent",
    ...base,
    customerId: required(result.claims?.sub, "customer"),
    scopes: scopes(result.claims?.scope),
  };
}
export async function normalizeBrowserContext(
  client: BrowserClient,
  resolve: AgentResolver,
  options: { poppyConfigured: boolean },
): Promise<Actor> {
  if (options?.poppyConfigured !== true)
    throw new Error(
      "Poppy browser SDK must be explicitly configured; getContext otherwise reports human",
    );
  if (
    typeof client?.poppy?.getContext !== "function" ||
    typeof client?.getSession !== "function"
  )
    throw new Error(
      "Poppy SDK unsupported: install a compatible build of nextjs-auth0 PR #2939 with server poppy.getContext and getSession",
    );
  const context = await client.poppy.getContext();
  const session = await client.getSession();
  if (!context || (context.kind !== "human" && context.kind !== "agent"))
    throw new Error("Incompatible Poppy browser context");
  if (context.kind === "human")
    return session
      ? {
          kind: "human",
          customerId: required(session.user?.sub, "customer"),
          scopes: [],
        }
      : { kind: "unauthenticated", scopes: [] };
  const base = {
    agentId: accepted(context.act?.sub, "browser", resolve),
    pairwiseUserId: required(context.act?.poppy_user_id, "pairwise user"),
    sessionId: required(context.act?.poppy_sid, "session"),
  };
  if (context.state === "guest") {
    if (session)
      throw new Error("Guest browser unexpectedly has an account session");
    return { kind: "guest-agent", ...base, scopes: [] };
  }
  if (
    context.state !== "signed_in" ||
    !session ||
    session.user?.sub !== context.sub
  )
    throw new Error("Browser account does not match verified Poppy context");
  if (
    !Array.isArray(context.scopes) ||
    !context.scopes.every((s) => typeof s === "string")
  )
    throw new Error("Invalid verified scopes");
  return {
    kind: "signed-in-agent",
    ...base,
    customerId: required(context.sub, "customer"),
    scopes: [...context.scopes],
  };
}
export function canLinkGuest(guest: Actor, signedIn: Actor): boolean {
  return (
    guest.kind === "guest-agent" &&
    signedIn.kind === "signed-in-agent" &&
    guest.agentId === signedIn.agentId &&
    guest.pairwiseUserId === signedIn.pairwiseUserId &&
    guest.sessionId === signedIn.sessionId &&
    !!signedIn.customerId
  );
}
export function sameOperationPrincipal(a: Actor, b: Actor): boolean {
  if (
    (a.kind !== "guest-agent" && a.kind !== "signed-in-agent") ||
    (b.kind !== "guest-agent" && b.kind !== "signed-in-agent")
  )
    return false;
  return (
    a.kind === b.kind &&
    a.agentId === b.agentId &&
    a.pairwiseUserId === b.pairwiseUserId &&
    (a.kind === "guest-agent" ||
      (b.kind === "signed-in-agent" && a.customerId === b.customerId))
  );
}
