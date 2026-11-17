import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  mintCustomerAccessToken,
  TEST_DOMAIN,
} from "../../../shopping-merchant/tests/support/identity-jwt.js";
import { OAUTH_COOKIE } from "../src/env.js";
import { signValue } from "../src/crypto-util.js";
import {
  ORIGIN,
  SESSION_SECRET,
  apiJson,
  buildProductionWorkerBundle,
  startHarness,
  type DispatchResponse,
  type Harness,
} from "./support/harness.js";

let harness: Harness;

function cookieHeader(res: DispatchResponse, name: string): string | undefined {
  const raw = res.headers.getSetCookie?.() ?? [];
  const joined =
    raw.length > 0
      ? raw.join("; ")
      : (res.headers.get("set-cookie") ?? undefined);
  if (!joined) return undefined;
  const match = joined.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

before(async () => {
  harness = await startHarness({
    outbound: async (req) => {
      const url = new URL(req.url);
      if (
        url.hostname === TEST_DOMAIN &&
        url.pathname === "/oauth/token" &&
        req.method === "POST"
      ) {
        const body = await req.text();
        const params = new URLSearchParams(body);
        if (!params.get("code_verifier")) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (params.get("grant_type") !== "authorization_code") {
          return new Response(JSON.stringify({ error: "unsupported" }), {
            status: 400,
          });
        }
        const accessToken = await mintCustomerAccessToken();
        return Response.json({
          access_token: accessToken,
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      return new Response("upstream_unavailable", { status: 502 });
    },
  });
});

after(async () => {
  await harness.mf.dispose();
});

test("login redirects to Auth0 with PKCE challenge", async () => {
  const res = await harness.mf.dispatchFetch(`${ORIGIN}/auth/login`, {
    redirect: "manual",
  });
  assert.equal(res.status, 302);
  const location = res.headers.get("location");
  assert.ok(location);
  const authorize = new URL(location!);
  assert.equal(authorize.hostname, TEST_DOMAIN);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorize.searchParams.get("code_challenge"));
  assert.ok(authorize.searchParams.get("state"));
  assert.equal(authorize.searchParams.get("nonce"), null);
  assert.ok(cookieHeader(res, OAUTH_COOKIE));
});

test("login selects the configured Auth0 connection", async () => {
  const configured = await startHarness({
    bindings: { SHOPPING_AUTH0_CONNECTION: "email" },
  });
  try {
    const res = await configured.mf.dispatchFetch(`${ORIGIN}/auth/login`, {
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(
      new URL(res.headers.get("location")!).searchParams.get("connection"),
      "email",
    );
  } finally {
    await configured.mf.dispose();
  }
});

test("callback rejects forged oauth cookie", async () => {
  const res = await harness.mf.dispatchFetch(
    `${ORIGIN}/auth/callback?code=x&state=y`,
    {
      headers: {
        cookie: `${OAUTH_COOKIE}=${encodeURIComponent("not-signed")}`,
      },
    },
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code?: string };
  assert.equal(body.code, "invalid_oauth_state");
});

test("callback rejects expired oauth transaction", async () => {
  const state = "state-expired";
  const tx = {
    state,
    verifier: "verifier-abc",
    exp: Date.now() - 1000,
  };
  const signed = await signValue(SESSION_SECRET, JSON.stringify(tx));
  const res = await harness.mf.dispatchFetch(
    `${ORIGIN}/auth/callback?code=x&state=${state}`,
    {
      headers: { cookie: `${OAUTH_COOKIE}=${encodeURIComponent(signed)}` },
    },
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code?: string };
  assert.equal(body.code, "invalid_oauth_state");
});

test("callback rejects state mismatch", async () => {
  const login = await harness.mf.dispatchFetch(`${ORIGIN}/auth/login`, {
    redirect: "manual",
  });
  const oauth = cookieHeader(login, OAUTH_COOKIE);
  assert.ok(oauth);
  const res = await harness.mf.dispatchFetch(
    `${ORIGIN}/auth/callback?code=x&state=wrong-state`,
    { headers: { cookie: `${OAUTH_COOKIE}=${encodeURIComponent(oauth)}` } },
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code?: string };
  assert.equal(body.code, "invalid_oauth_state");
});

test("callback fails closed when token exchange fails", async () => {
  const login = await harness.mf.dispatchFetch(`${ORIGIN}/auth/login`, {
    redirect: "manual",
  });
  const location = login.headers.get("location");
  assert.ok(location);
  const state = new URL(location!).searchParams.get("state");
  const oauth = cookieHeader(login, OAUTH_COOKIE);
  assert.ok(state && oauth);

  const badHarness = await startHarness({
    outbound: async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    const res = await badHarness.mf.dispatchFetch(
      `${ORIGIN}/auth/callback?code=bad&state=${state}`,
      { headers: { cookie: `${OAUTH_COOKIE}=${encodeURIComponent(oauth)}` } },
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "token_exchange_failed");
  } finally {
    await badHarness.mf.dispose();
  }
});

test("oauth callback rejects replay without transaction cookie", async () => {
  const login = await harness.mf.dispatchFetch(`${ORIGIN}/auth/login`, {
    redirect: "manual",
  });
  const location = login.headers.get("location");
  const oauth = cookieHeader(login, OAUTH_COOKIE);
  assert.ok(location && oauth);
  const state = new URL(location!).searchParams.get("state");
  const first = await harness.mf.dispatchFetch(
    `${ORIGIN}/auth/callback?code=once&state=${state}`,
    {
      redirect: "manual",
      headers: { cookie: `${OAUTH_COOKIE}=${encodeURIComponent(oauth)}` },
    },
  );
  assert.equal(first.status, 303);
  const replay = await harness.mf.dispatchFetch(
    `${ORIGIN}/auth/callback?code=once&state=${state}`,
  );
  assert.equal(replay.status, 400);
  const body = (await replay.json()) as { code?: string };
  assert.equal(body.code, "invalid_oauth_callback");
});

test("callback completes PKCE login and sets session cookie", async () => {
  const login = await harness.mf.dispatchFetch(`${ORIGIN}/auth/login`, {
    redirect: "manual",
  });
  const location = login.headers.get("location");
  const oauth = cookieHeader(login, OAUTH_COOKIE);
  assert.ok(location && oauth);
  const state = new URL(location!).searchParams.get("state");

  const callback = await harness.mf.dispatchFetch(
    `${ORIGIN}/auth/callback?code=pkce-code&state=${state}`,
    {
      redirect: "manual",
      headers: {
        cookie: `${OAUTH_COOKIE}=${encodeURIComponent(oauth!)}`,
      },
    },
  );
  assert.equal(callback.status, 303);
  const sessionCookie = cookieHeader(callback, "nsh_sid");
  assert.ok(sessionCookie);

  const { status } = await apiJson(harness.mf, "/api/cart", {
    cookie: `nsh_sid=${encodeURIComponent(sessionCookie)}`,
  });
  assert.equal(status, 200);
});

test("production app returns 404 for test seed-session", async () => {
  const { script } = await buildProductionWorkerBundle();
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "prod",
          modules: true,
          script,
          compatibilityDate: "2026-10-09",
          bindings: {
            SHOPPING_SESSION_SECRET: SESSION_SECRET,
            SHOPPING_AUTH0_DOMAIN: TEST_DOMAIN,
            SHOPPING_API_AUDIENCE: "https://shopping-api.example",
          },
          durableObjects: {
            CUSTOMER_STATE: { className: "CustomerHostState", useSQLite: true },
          },
        },
      ],
    }),
  );
  try {
    const res = await mf.dispatchFetch(`${ORIGIN}/test/seed-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: "auth0|x" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await mf.dispose();
  }
});
