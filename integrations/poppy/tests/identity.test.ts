import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyApiRequest,
  normalizeBrowserContext,
  canLinkGuest,
  sameOperationPrincipal,
  type ApiClient,
  type BrowserClient,
  type VerifiedRequest,
} from "../src/index.js";
const resolve = (id: string) =>
  (
    ({
      "https://agent.example/metadata": "agent-1",
      "auth0-agent": "agent-1",
    }) as Record<string, string>
  )[id];
const poppy = {
  sessionId: "session-1",
  userId: "pairwise",
  agent: { cimdUrl: "https://agent.example/metadata" },
  state: "signed_in" as const,
  source: "header" as const,
};
const api = (result: VerifiedRequest): ApiClient => ({
  async verifyPoppyRequest(options) {
    if (options.headers["poppy-session"])
      assert.equal(options.requireSession, true);
    return result;
  },
});
const request = (headers: Record<string, string> = {}) =>
  new Request("https://shop.example/cart", { headers });
const browser = (
  context: Awaited<ReturnType<BrowserClient["poppy"]["getContext"]>>,
  sub: string | null,
): BrowserClient => ({
  poppy: {
    async getContext() {
      return context;
    },
  },
  async getSession() {
    return sub ? { user: { sub } } : null;
  },
});
const configured = { poppyConfigured: true };
const agentContext = {
  kind: "agent" as const,
  state: "signed_in" as const,
  sub: "customer",
  act: {
    sub: "auth0-agent",
    poppy_sid: "session-1",
    poppy_user_id: "pairwise",
  },
  scopes: ["cart:write"],
};
test("verified API and browser identities preserve account, pairwise identity and scopes", async () => {
  const a = await verifyApiRequest(
    api({ poppy, claims: { sub: "customer", scope: "cart:write" } }),
    request({ "poppy-session": "opaque" }),
    resolve,
  );
  const b = await normalizeBrowserContext(
    browser(agentContext, "customer"),
    resolve,
    configured,
  );
  assert.deepEqual(a, b);
  assert.equal(a.kind, "signed-in-agent");
  const c = await verifyApiRequest(
    api({
      poppy: { ...poppy, source: "token" },
      claims: { sub: "customer", scope: "cart:write" },
    }),
    request({ authorization: "Bearer token" }),
    resolve,
  );
  assert.deepEqual(c, b);
});
test("guest is not customer and linking requires all three continuity values", async () => {
  const guest = await verifyApiRequest(
    api({
      poppy: { ...poppy, state: "signed_out" },
      claims: { sub: "anon_poppy@guest" },
    }),
    request(),
    resolve,
  );
  const headerGuest = await verifyApiRequest(
    api({ poppy, claims: { sub: "anon_poppy@guest" } }),
    request(),
    resolve,
  );
  assert.equal(headerGuest.kind, "guest-agent");
  assert.equal(guest.kind, "guest-agent");
  assert.equal("customerId" in guest, false);
  const signed = await normalizeBrowserContext(
    browser(agentContext, "customer"),
    resolve,
    configured,
  );
  assert.equal(canLinkGuest(guest, signed), true);
  if (signed.kind !== "signed-in-agent") throw new Error("wrong kind");
  assert.equal(canLinkGuest(guest, { ...signed, sessionId: "other" }), false);
  assert.equal(
    canLinkGuest(guest, { ...signed, pairwiseUserId: "other" }),
    false,
  );
  assert.equal(canLinkGuest(guest, { ...signed, agentId: "other" }), false);
  assert.equal(
    sameOperationPrincipal(signed, { ...signed, sessionId: "new" }),
    true,
  );
  assert.equal(
    sameOperationPrincipal(signed, { ...signed, customerId: "other" }),
    false,
  );
  assert.equal(sameOperationPrincipal(signed, guest), false);
});
test("missing credentials never produce human; human requires browser SDK session", async () => {
  assert.equal(
    (await verifyApiRequest(api({}), request(), resolve)).kind,
    "unauthenticated",
  );
  assert.equal(
    (
      await verifyApiRequest(
        api({ claims: { sub: "human" } }),
        request(),
        resolve,
      )
    ).kind,
    "unauthenticated",
  );
  assert.equal(
    (
      await normalizeBrowserContext(
        browser({ kind: "human" }, null),
        resolve,
        configured,
      )
    ).kind,
    "unauthenticated",
  );
  assert.deepEqual(
    await normalizeBrowserContext(
      browser({ kind: "human" }, "customer"),
      resolve,
      configured,
    ),
    { kind: "human", customerId: "customer", scopes: [] },
  );
});
test("rejects unsupported SDK, missing verified session, account mismatch and unaccepted agents", async () => {
  await assert.rejects(
    () => verifyApiRequest({} as ApiClient, request(), resolve),
    /unsupported.*#342/,
  );
  await assert.rejects(
    () => normalizeBrowserContext({} as BrowserClient, resolve, configured),
    /unsupported.*#2939/,
  );
  await assert.rejects(
    () =>
      normalizeBrowserContext(browser({ kind: "human" }, "customer"), resolve, {
        poppyConfigured: false,
      }),
    /explicitly configured/,
  );
  await assert.rejects(
    () =>
      verifyApiRequest(api({}), request({ "poppy-session": "bad" }), resolve),
    /not verified/,
  );
  await assert.rejects(
    () =>
      verifyApiRequest(
        api({ claims: { sub: "customer", act: { sub: "human" } } }),
        request(),
        resolve,
      ),
    /not verified/,
  );
  await assert.rejects(
    () =>
      verifyApiRequest(
        api({
          poppy: { ...poppy, source: "token" },
          claims: { sub: "customer" },
        }),
        request(),
        () => undefined,
      ),
    /not accepted/,
  );
  await assert.rejects(
    () =>
      verifyApiRequest(
        api({ poppy, claims: { sub: "customer" } }),
        request(),
        () => undefined,
      ),
    /not accepted/,
  );
  await assert.rejects(
    () =>
      normalizeBrowserContext(
        browser(agentContext, "customer"),
        () => undefined,
        configured,
      ),
    /not accepted/,
  );
  await assert.rejects(
    () =>
      normalizeBrowserContext(
        browser(agentContext, "other"),
        resolve,
        configured,
      ),
    /does not match/,
  );
  await assert.rejects(
    () =>
      normalizeBrowserContext(
        browser({ ...agentContext, state: "guest" }, "customer"),
        resolve,
        configured,
      ),
    /Guest browser/,
  );
});
