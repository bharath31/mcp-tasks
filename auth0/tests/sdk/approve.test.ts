// approve(): the proof is an Auth0-signed token. These tests run the real SDK code,
// the real approval Action, and real OAuth over HTTPS against the local OIDC provider
// (not Auth0; see helpers/oidc-server.ts). What they pin: only a fresh passkey sign-in
// by an allowed person, for these exact arguments, run and step, counts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { SignJWT, generateKeyPair, importJWK } from "jose";
import { Agent, fetch as undiciFetch } from "undici";
import {
  ApprovalError,
  ApprovalRejected,
  approvalConfig,
  approvalKey,
  approvalLink,
  approvalBinding,
  auth0RolesRecheck,
  createApprovalRequest,
  actionDigest,
  handleApprovalRoute,
  pollPush,
  requireApproval,
  startPush,
  verifyApproval,
  verifyAgentsApproval,
  type ApprovalConfig,
  type ApprovalInput,
  type ApprovalStore,
  type Delivery,
} from "@task-authority/sdk/approve";
import {
  MFA_CODE,
  startOidcServer,
  type OidcServer,
} from "../helpers/oidc-server.js";

const require = createRequire(import.meta.url);
const action = require("../../actions/agent-approval.cjs");
function actionForClient(file: string) {
  const out: any = {};
  const source = readFileSync(
    new URL(`../../actions/${file}`, import.meta.url),
    "utf8",
  ).replace('"__APPROVAL_CLIENT_ID__"', '"email-approvals"');
  new Function("exports", source)(out);
  return out;
}
const mfaAction = actionForClient("agent-approval-mfa.cjs");
const assuranceAction = actionForClient("agent-approval-assurance.cjs");
const APP = "https://refunds.test";
const AUDIENCE = "https://refunds.test/approvals";
const alice = {
  key: "alice",
  sub: "auth0|alice",
  name: "Alice Finance",
  org: "org_1",
  email: "alice@example.com",
  roles: ["finance"],
};
const bob = {
  key: "bob",
  sub: "auth0|bob",
  name: "Bob",
  org: "org_1",
  email: "bob@example.com",
};

let oidc: OidcServer;
let cfg: ApprovalConfig;
let tlsFetch: typeof fetch;

before(async () => {
  oidc = await startOidcServer({
    users: [alice, bob],
    clients: [
      {
        id: "approvals",
        secret: "s3cret-s3cret",
        redirectUris: [`${APP}/approve/callback`],
      },
      { id: "agent", secret: "agent-secret" },
      {
        id: "email-approvals",
        secret: "email-secret",
        redirectUris: [`${APP}/approve/callback`],
        metadata: {
          task_authority_approval: "webauthn-mfa",
          approval_mfa_factors: "webauthn-platform,webauthn-roaming",
        },
      },
    ],
    resourceAudiences: [AUDIENCE],
    postLoginActions: [action, mfaAction, assuranceAction],
  });
  const agent = new Agent({ connect: { ca: readFileSync(oidc.caPath) } });
  tlsFetch = ((url: string | URL | Request, init?: RequestInit) =>
    undiciFetch(url as string, {
      ...(init as object),
      dispatcher: agent,
    })) as unknown as typeof fetch;
  cfg = approvalConfig(
    {},
    {
      domain: oidc.domain,
      clientId: "approvals",
      clientSecret: "s3cret-s3cret",
      appUrl: APP,
      audience: AUDIENCE,
      fetch: tlsFetch,
    },
  );
});
after(() => oidc.close());

const refund: ApprovalInput = {
  action: "refund:create",
  resource: "payment:pay_123",
  args: { paymentId: "pay_123", amountMinor: 15000, currency: "USD" },
  approvers: { roles: ["finance"] },
  requester: "agent_returns",
  summary: "Refund 150.00 USD to order 123",
};

/** Opens the link, presses a button, signs in at the IdP, and returns the callback's response. */
async function decide(
  link: string,
  decision: "approve" | "reject",
  who: { user: string; method: "passkey" | "pwd" | "email"; factor?: string },
  deliveries: Delivery[],
  store?: ApprovalStore,
  config = cfg,
) {
  const routes = (req: Request) =>
    handleApprovalRoute(req, config, {
      deliver: async (d) => void deliveries.push(d),
      appName: "Refund Desk",
      store,
    });
  const page = await routes(new Request(link));
  assert.equal(page?.status, 200);
  const r = new URL(link).searchParams.get("r")!;
  const start = await routes(
    new Request(`${APP}/approve`, {
      method: "POST",
      body: new URLSearchParams({ r, decision }),
    }),
  );
  assert.equal(start?.status, 303);
  const authorize = new URL(start!.headers.get("location")!);
  assert.equal(authorize.origin, new URL(oidc.issuer).origin);
  assert.equal(authorize.searchParams.get("prompt"), "login");
  assert.equal(authorize.searchParams.get("max_age"), "0");
  const login = await tlsFetch(`${oidc.issuer}authorize`, {
    method: "POST",
    body: new URLSearchParams({
      ...Object.fromEntries(authorize.searchParams),
      _user: who.user,
      _method: who.method,
      _mfa: MFA_CODE,
      _factor: who.factor ?? "otp",
    }),
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  const callback = login.headers.get("location")!;
  assert.ok(callback.startsWith(`${APP}/approve/callback`));
  const res = (await routes(new Request(callback)))!;
  return { res, body: await res.text(), authorize };
}

test("email OTP requires a fresh WebAuthn MFA proof after the Action pause", async () => {
  const emailCfg = approvalConfig(
    {},
    {
      ...cfg,
      clientId: "email-approvals",
      clientSecret: "email-secret",
      connection: "email",
      loginMethod: "email-otp",
    },
  );
  const request = await createApprovalRequest({
    ...refund,
    run: "email-otp-approval",
    step: "refund",
  });
  const link = await approvalLink(emailCfg, request);
  const deliveries: Delivery[] = [];
  const denied = await decide(
    link,
    "approve",
    { user: "alice", method: "email", factor: "otp" },
    deliveries,
    undefined,
    emailCfg,
  );
  assert.equal(denied.res.status, 502, denied.body);
  assert.equal(deliveries.length, 0);
  const accepted = await decide(
    link,
    "approve",
    { user: "alice", method: "email", factor: "webauthn-platform" },
    deliveries,
    undefined,
    emailCfg,
  );
  assert.equal(accepted.res.status, 200, accepted.body);
  assert.equal(accepted.authorize.searchParams.get("connection"), "email");
  assert.equal(accepted.authorize.searchParams.get("agent_approval"), "mfa");
  assert.equal(deliveries.length, 1);
  assert.equal(
    (await requireApproval(emailCfg, request, deliveries[0]!.proof)).method,
    "passkey",
  );
});

test("WebAuthn MFA proof uses the ceremony time even when email login was earlier", async () => {
  const now = Math.floor(Date.now() / 1000);
  const request = await createApprovalRequest({
    ...refund,
    run: "delayed-mfa",
    step: "refund",
    now: (now - 120) * 1000,
  });
  const key = await importJWK(oidc.privateJwk, "RS256");
  const proof = async (factor: string, at: number) =>
    new SignJWT({
      auth_time: now - 60,
      nonce: await approvalBinding(request, "approve"),
      "https://task-authority.example/approval": {
        method: "passkey",
        factor,
        at,
        roles: ["finance"],
      },
    })
      .setProtectedHeader({ alg: "RS256", kid: "oidc-1" })
      .setIssuer(oidc.issuer)
      .setAudience(cfg.clientId)
      .setSubject(alice.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(key);
  assert.equal(
    (await verifyApproval(cfg, request, await proof("webauthn-platform", now)))
      .at,
    now,
  );
  for (const [factor, at] of [
    ["otp", now],
    ["webauthn-platform", now + 90],
    ["webauthn-platform", now - 90],
  ] as const)
    await assert.rejects(
      verifyApproval(cfg, request, await proof(factor, at)),
      (error: ApprovalError) => error.code === "no_passkey",
    );
});

test("MFA Actions challenge recent sessions, scope their client, and refuse missing or stale assurance", async () => {
  const at = (offset: number) => new Date(Date.now() + offset).toISOString();
  const client = {
    client_id: "email-approvals",
    metadata: {
      task_authority_approval: "webauthn-mfa",
      approval_mfa_factors: "webauthn-platform",
    },
  };
  const event = {
    client,
    user: {
      email_verified: true,
      enrolledFactors: [{ type: "webauthn-platform" }],
    },
    authentication: {
      methods: [
        { name: "mfa", type: "webauthn-platform", timestamp: at(-1000) },
      ],
    },
  };
  let challenges = 0;
  await mfaAction.onExecutePostLogin(event, {
    access: { deny: assert.fail },
    multifactor: {
      enable: (provider: string, options: unknown) => {
        assert.equal(provider, "any");
        assert.deepEqual(options, { allowRememberBrowser: false });
      },
    },
    authentication: {
      challengeWith: () => {
        challenges++;
      },
      enrollWithAny: assert.fail,
    },
  });
  assert.equal(
    challenges,
    1,
    "a recent session factor never skips this transaction's challenge",
  );
  await mfaAction.onExecutePostLogin(
    { ...event, client: { ...client, client_id: "unrelated-client" } },
    {
      access: { deny: assert.fail },
      authentication: {
        challengeWith: assert.fail,
        enrollWithAny: assert.fail,
      },
    },
  );
  for (const methods of [
    [],
    [{ name: "mfa", type: "webauthn-platform", timestamp: at(-600000) }],
    [{ name: "mfa", type: "webauthn-platform", timestamp: at(60000) }],
    [
      { name: "mfa", type: "webauthn-platform", timestamp: at(-10000) },
      { name: "mfa", type: "otp", timestamp: at(0) },
    ],
  ]) {
    let denied = false;
    await assuranceAction.onExecutePostLogin(
      { ...event, request: { query: {} }, authentication: { methods } },
      {
        access: {
          deny: () => {
            denied = true;
          },
        },
        idToken: { setCustomClaim: assert.fail },
      },
    );
    assert.equal(denied, true);
  }
});

test("a fresh passkey sign-in by an allowed approver proves this exact request", async () => {
  const r = await createApprovalRequest({
    ...refund,
    run: "run-1",
    step: "refund",
  });
  const deliveries: Delivery[] = [];
  const page = await handleApprovalRoute(
    new Request(await approvalLink(cfg, r)),
    cfg,
    {
      deliver: async () => assert.fail("no delivery yet"),
    },
  );
  const html = await page!.text();
  assert.match(html, /Refund 150\.00 USD to order 123/);
  assert.match(html, /pay_123/);
  assert.match(html, /15000/);
  assert.match(
    page!.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );

  const { res, body } = await decide(
    await approvalLink(cfg, r),
    "approve",
    { user: "alice", method: "passkey" },
    deliveries,
  );
  assert.equal(res.status, 200, body);
  assert.match(body, /Alice Finance approved/);
  assert.equal(deliveries.length, 1);

  // The workflow's own check, against its own copy of the request.
  const ok = await requireApproval(cfg, r, deliveries[0]!.proof);
  assert.equal(ok.decision, "approve");
  assert.equal(
    (await verifyAgentsApproval(cfg, r, { proof: deliveries[0]!.proof }))
      .decision,
    "approve",
  );
  assert.equal(ok.method, "passkey");
  assert.equal(ok.approver.sub, alice.sub);
  assert.deepEqual(ok.approver.roles, ["finance"]);
  assert.match(ok.key, /^apv_[a-f0-9]{40}$/);
  // Same run and step, same key, even for a request rebuilt a minute later: a retried
  // step reuses the provider's idempotency key. (The proof itself binds the original
  // request's expiry, which is why adapters memoize the request in a step.)
  const again = await createApprovalRequest({
    ...refund,
    run: "run-1",
    step: "refund",
    now: Date.now() + 60_000,
  });
  assert.equal(await approvalKey(again), ok.key);
  assert.equal(
    await verifyApproval(cfg, again, deliveries[0]!.proof).catch(
      (e: ApprovalError) => e.code,
    ),
    "wrong_request",
  );

  // The proof means nothing anywhere else.
  const code = async (p: Promise<unknown>) =>
    p.then(
      () => "accepted",
      (e) => (e instanceof ApprovalError ? e.code : String(e)),
    );
  const proof = deliveries[0]!.proof;
  assert.equal(
    await code(
      verifyApproval(
        cfg,
        await createApprovalRequest({
          ...refund,
          run: "run-2",
          step: "refund",
        }),
        proof,
      ),
    ),
    "wrong_request",
  );
  assert.equal(
    await code(
      verifyApproval(
        cfg,
        await createApprovalRequest({
          ...refund,
          args: { ...refund.args, amountMinor: 99_999_00 },
          run: "run-1",
          step: "refund",
        }),
        proof,
      ),
    ),
    "wrong_request",
  );
  // The workflow's approvers rule is what counts, not the approver's say-so.
  assert.equal(
    await code(
      verifyApproval(cfg, { ...r, approvers: { users: [bob.sub] } }, proof),
    ),
    "not_an_approver",
  );
});

test("a password sign-in is refused by the Action and nothing is delivered", async () => {
  const r = await createApprovalRequest({
    ...refund,
    run: "run-pwd",
    step: "refund",
  });
  const deliveries: Delivery[] = [];
  const { res, body } = await decide(
    await approvalLink(cfg, r),
    "approve",
    { user: "alice", method: "pwd" },
    deliveries,
  );
  assert.equal(res.status, 502);
  assert.match(body, /Approvals need a passkey/);
  assert.equal(deliveries.length, 0);
});

test("someone outside the approvers is refused before delivery", async () => {
  const r = await createApprovalRequest({
    ...refund,
    run: "run-bob",
    step: "refund",
  });
  const deliveries: Delivery[] = [];
  const { res, body } = await decide(
    await approvalLink(cfg, r),
    "approve",
    { user: "bob", method: "passkey" },
    deliveries,
  );
  assert.equal(res.status, 403);
  assert.match(body, /not allowed to decide/);
  assert.equal(deliveries.length, 0);
});

test("the requester can't approve its own request, even with the role", async () => {
  const r = await createApprovalRequest({
    ...refund,
    requester: alice.sub,
    run: "run-self",
    step: "refund",
  });
  const deliveries: Delivery[] = [];
  const { res } = await decide(
    await approvalLink(cfg, r),
    "approve",
    { user: "alice", method: "passkey" },
    deliveries,
  );
  assert.equal(res.status, 403);
  assert.equal(deliveries.length, 0);
});

test("a rejection is a verified decision too", async () => {
  const r = await createApprovalRequest({
    ...refund,
    run: "run-no",
    step: "refund",
  });
  const deliveries: Delivery[] = [];
  const { res, body } = await decide(
    await approvalLink(cfg, r),
    "reject",
    { user: "alice", method: "passkey" },
    deliveries,
  );
  assert.equal(res.status, 200);
  assert.match(body, /won't do this/);
  const v = await verifyApproval(cfg, r, deliveries[0]!.proof);
  assert.equal(v.decision, "reject");
  await assert.rejects(
    requireApproval(cfg, r, deliveries[0]!.proof),
    ApprovalRejected,
  );
});

test("forged, foreign and agent tokens are not proofs", async () => {
  const r = await createApprovalRequest({
    ...refund,
    run: "run-forge",
    step: "refund",
  });
  const code = (p: Promise<unknown>) =>
    p.then(
      () => "accepted",
      (e) => (e as ApprovalError).code,
    );
  assert.equal(await code(verifyApproval(cfg, r, undefined)), "invalid_proof");
  assert.equal(await code(verifyApproval(cfg, r, "a.b.c")), "invalid_proof");
  // Right claims, wrong signer.
  const { privateKey } = await generateKeyPair("RS256");
  const forged = await new SignJWT({ nonce: "x", auth_time: r.iat })
    .setProtectedHeader({ alg: "RS256", kid: "oidc-1" })
    .setIssuer(oidc.issuer)
    .setAudience("approvals")
    .setSubject(alice.sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  assert.equal(await code(verifyApproval(cfg, r, forged)), "invalid_proof");
  // The agent's own client-credentials token is signed by the tenant but is not a proof.
  const cc = await tlsFetch(`${oidc.issuer}oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "agent",
      client_secret: "agent-secret",
      audience: AUDIENCE,
    }),
  }).then((x) => x.json() as Promise<{ access_token: string }>);
  assert.equal(
    await code(verifyApproval(cfg, r, cc.access_token)),
    "invalid_proof",
  );
});

test("links are signed and expire", async () => {
  const r = await createApprovalRequest({
    ...refund,
    run: "run-exp",
    step: "refund",
    expiresIn: "2m",
  });
  const link = await approvalLink(cfg, r);
  const routes = (req: Request, now?: number) =>
    handleApprovalRoute(req, cfg, {
      deliver: async () => assert.fail("no delivery"),
      ...(now ? { now: () => now } : {}),
    });
  const tampered = new URL(link);
  tampered.searchParams.set(
    "r",
    `${tampered.searchParams.get("r")!.slice(0, -2)}xx`,
  );
  assert.equal((await routes(new Request(tampered)))?.status, 400);
  const late = await routes(new Request(link), (r.exp + 5) * 1000);
  assert.equal(late?.status, 403);
  assert.match(await late!.text(), /expired/);
  // Not ours: the router moves on.
  assert.equal(await routes(new Request(`${APP}/orders`)), null);
});

test("approval pages show approver labels, money, and a live expiry countdown", async () => {
  const r = await createApprovalRequest({
    ...refund,
    approvers: { users: [alice.sub] },
    approverLabels: { [alice.sub]: "Alice Finance" },
    run: "run-labels",
    step: "refund",
  });
  const page = await handleApprovalRoute(
    new Request(await approvalLink(cfg, r)),
    cfg,
    { deliver: async () => assert.fail("no delivery") },
  );
  const body = await page!.text();
  assert.match(body, /Alice Finance/);
  assert.match(body, /\$150\.00/);
  assert.match(body, /15000/);
  assert.match(body, /setInterval\(tick,1000\)/);

  const expired = await handleApprovalRoute(
    new Request(await approvalLink(cfg, { ...r, exp: 1 })),
    cfg,
    { deliver: async () => assert.fail("no delivery"), now: () => 2_000 },
  );
  const expiredBody = await expired!.text();
  assert.match(expiredBody, /This request has expired/);
  assert.doesNotMatch(expiredBody, /approval-form/);
});

test("large approval links use the configured store and cannot be edited", async () => {
  const r = await createApprovalRequest({
    ...refund,
    id: "external-refund/2026-10-24",
    args: { ...refund.args, notes: "x".repeat(9000) },
    run: "run-large",
    step: "refund",
  });
  await assert.rejects(approvalLink(cfg, r), /too large for a link/);
  const rows = new Map<string, typeof r>();
  const store = {
    put: async (id: string, request: typeof r) => void rows.set(id, request),
    get: async (id: string) => rows.get(id),
  };
  const link = await approvalLink(cfg, r, store);
  assert.ok(link.length < 1024);
  assert.equal(rows.get(r.id), r);
  const page = await handleApprovalRoute(new Request(link), cfg, {
    deliver: async () => assert.fail("no delivery"),
    store,
  });
  assert.equal(page?.status, 200);
  const deliveries: Delivery[] = [];
  const { res, body } = await decide(
    link,
    "approve",
    { user: "alice", method: "passkey" },
    deliveries,
    store,
  );
  assert.equal(res.status, 200, body);
  assert.equal(deliveries.length, 1);
  const tampered = new URL(link);
  tampered.searchParams.set("r", "@apr_00000000000000000000000000000000");
  assert.equal(
    (
      await handleApprovalRoute(new Request(tampered), cfg, {
        deliver: async () => {},
      })
    )?.status,
    400,
  );
});

test("approval requests snapshot args before computing their digest", async () => {
  const args = { ...refund.args };
  const input = { ...refund, args };
  const r = await createApprovalRequest({
    ...input,
    run: "run-args-snapshot",
    step: "refund",
  });
  const digest = r.digest;
  args.amountMinor = 99_999;
  assert.equal(r.args.amountMinor, 15000);
  assert.equal(
    r.digest,
    await actionDigest({ ...input, args: { ...refund.args } }),
  );
  assert.equal(r.digest, digest);
});

test("an optional requester DPoP thumbprint is part of the approval binding", async () => {
  const base = await createApprovalRequest({
    ...refund,
    requesterJkt: "thumbprint-a",
    run: "run-jkt",
    step: "refund",
  });
  const changed = { ...base, requesterJkt: "thumbprint-b" };
  assert.notEqual(
    await approvalBinding(base, "approve"),
    await approvalBinding(changed, "approve"),
  );
});

test("Auth0 role recheck requires one of the request's roles to remain assigned", async () => {
  let authorization = "";
  const recheckCfg = {
    ...cfg,
    fetch: (async (input, init) => {
      assert.match(String(input), /api\/v2\/users\/auth0%7Calice\/roles$/);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json([{ name: "finance" }]);
    }) as typeof fetch,
  };
  const r = await createApprovalRequest({
    ...refund,
    run: "run-role",
    step: "refund",
  });
  const link = await approvalLink(cfg, r);
  const deliveries: Delivery[] = [];
  await decide(
    link,
    "approve",
    { user: "alice", method: "passkey" },
    deliveries,
  );
  const approval = await verifyApproval(cfg, r, deliveries[0]!.proof);
  assert.equal(
    await auth0RolesRecheck(recheckCfg, "management-token")(approval),
    true,
  );
  assert.equal(authorization, "Bearer management-token");

  const revokedCfg = {
    ...cfg,
    fetch: (async () => Response.json([{ name: "support" }])) as typeof fetch,
  };
  assert.equal(
    await auth0RolesRecheck(revokedCfg, "management-token")(approval),
    false,
  );
});

test("push: a CIBA approval with the binding in authorization_details is a proof", async () => {
  const r = await createApprovalRequest({
    ...refund,
    approvers: { users: [alice.sub] },
    via: "push",
    run: "run-push",
    step: "refund",
  });
  const push = await startPush(cfg, r);
  const sent = oidc.cibaRequests.get(push.authReqId)!;
  assert.ok(sent.message.length <= 64);
  assert.equal((await pollPush(cfg, push.authReqId)).status, "pending");
  oidc.cibaDecide(push.authReqId, true);
  const polled = await pollPush(cfg, push.authReqId);
  assert.equal(polled.status, "approved");
  const ok = await requireApproval(cfg, r, (polled as { proof: string }).proof);
  assert.equal(ok.method, "push");
  assert.equal(ok.approver.sub, alice.sub);
  // The same token can't approve another run.
  const other = await createApprovalRequest({
    ...refund,
    approvers: { users: [alice.sub] },
    via: "push",
    run: "run-push-2",
    step: "refund",
  });
  await assert.rejects(
    verifyApproval(cfg, other, (polled as { proof: string }).proof),
    (e: ApprovalError) => e.code === "wrong_request",
  );

  const denied = await startPush(cfg, { ...r, id: "apr_denied" });
  oidc.cibaDecide(denied.authReqId, false);
  assert.equal((await pollPush(cfg, denied.authReqId)).status, "denied");
});

test("requests need approvers, and a push goes to exactly one person", async () => {
  await assert.rejects(
    createApprovalRequest({ ...refund, approvers: {}, run: "r", step: "s" }),
    /at least one approver/,
  );
  await assert.rejects(
    createApprovalRequest({
      ...refund,
      approvers: { users: [alice.sub, bob.sub] },
      via: "push",
      run: "r",
      step: "s",
    }),
    /one person/,
  );
  const rolePush = await createApprovalRequest({
    ...refund,
    via: "push",
    run: "r-role-push",
    step: "s",
  });
  await assert.rejects(startPush(cfg, rolePush), /resolveApprover/);
  const resolved = await startPush(cfg, rolePush, async (request) => {
    assert.deepEqual(request.approvers.roles, ["finance"]);
    return alice.sub;
  });
  oidc.cibaDecide(resolved.authReqId, true);
  assert.equal((await pollPush(cfg, resolved.authReqId)).status, "approved");
  await assert.rejects(
    createApprovalRequest({
      ...refund,
      args: { amount: 1.5 },
      run: "r",
      step: "s",
    }),
    /safe integers/,
  );
});

test("approval Action: only a fresh passkey on an approval sign-in gets the claim", async () => {
  const run = async (event: Record<string, unknown>) => {
    const out: { denied?: string; claims: Record<string, unknown> } = {
      claims: {},
    };
    await action.onExecutePostLogin(
      { request: { query: { agent_approval: "1" } }, ...event },
      {
        access: { deny: (m: string) => (out.denied = m) },
        idToken: {
          setCustomClaim: (k: string, v: unknown) => (out.claims[k] = v),
        },
      },
    );
    return out;
  };
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();
  const fresh = await run({
    authentication: { methods: [{ name: "passkey", timestamp: at(1000) }] },
    authorization: { roles: ["finance"] },
  });
  assert.equal(fresh.denied, undefined);
  assert.deepEqual(
    (
      fresh.claims["https://task-authority.example/approval"] as {
        method: string;
        roles: string[];
      }
    ).roles,
    ["finance"],
  );
  assert.match(
    (
      await run({
        authentication: { methods: [{ name: "pwd", timestamp: at(0) }] },
      })
    ).denied!,
    /passkey/,
  );
  assert.ok(
    (
      await run({
        authentication: {
          methods: [{ name: "passkey", timestamp: at(3_600_000) }],
        },
      })
    ).denied,
    "a passkey from an hour ago is not fresh",
  );
  assert.ok(
    (
      await run({
        agent: { agent_id: "agt_1" },
        authentication: { methods: [{ name: "passkey", timestamp: at(0) }] },
      })
    ).denied,
    "agents as principals are refused",
  );
  // Ordinary sign-ins are untouched.
  const ordinary = { denied: undefined as string | undefined, claims: {} };
  await action.onExecutePostLogin(
    { request: { query: {} }, authentication: { methods: [] } },
    {
      access: { deny: (m: string) => (ordinary.denied = m) },
      idToken: { setCustomClaim: assert.fail },
    },
  );
  assert.equal(ordinary.denied, undefined);
});
