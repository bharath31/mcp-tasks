// Unit tests for the pure parts of alex-login.mjs. Run: node --test demo/policy-desk/tools/alex-login.test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  LoginError,
  PORT,
  REDIRECT_URI,
  buildAuthorizeUrl,
  exchangeCode,
  main,
  makePkce,
  makeRedactor,
  parseArgs,
  parseCallback,
  waitForCallback,
} from "./alex-login.mjs";

const STATE = {
  tenant: "t.us.auth0.com",
  resourceServer: { identifier: "https://x/task-authority" },
  organization: { id: "org_123" },
  clients: {
    agentOwner: { client_id: "cid", client_secret: "CLIENT-SECRET-VALUE" },
  },
  alex: { email: "alex@example.com", password: "ALEX-PASSWORD-VALUE" },
};

test("PKCE challenge is the S256 of the verifier and values are random-looking", () => {
  const a = makePkce();
  assert.match(a.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(makePkce().verifier, a.verifier);
});

test("authorize URL carries org, audience, offline_access, PKCE and the loopback redirect", () => {
  const u = new URL(
    buildAuthorizeUrl({
      domain: "t.us.auth0.com",
      clientId: "cid",
      orgId: "org_1",
      audience: "aud",
      state: "s",
      challenge: "c",
    }),
  );
  assert.equal(u.origin, "https://t.us.auth0.com");
  const q = u.searchParams;
  assert.equal(q.get("redirect_uri"), "http://127.0.0.1:53682/callback");
  assert.equal(q.get("scope"), "openid offline_access");
  assert.equal(q.get("organization"), "org_1");
  assert.equal(q.get("audience"), "aud");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("state"), "s");
  assert.equal(REDIRECT_URI, `http://127.0.0.1:${PORT}/callback`);
});

test("callback parsing checks state, error and code", () => {
  assert.equal(parseCallback("/callback?code=abc&state=s", "s"), "abc");
  assert.throws(
    () => parseCallback("/callback?code=abc&state=zzz", "s"),
    /State mismatch/,
  );
  assert.throws(
    () =>
      parseCallback(
        "/callback?error=access_denied&error_description=no&state=s",
        "s",
      ),
    /access_denied/,
  );
  assert.throws(
    () => parseCallback("/callback?state=s", "s"),
    /no authorization code/,
  );
  assert.throws(() => parseCallback("/other?code=a&state=s", "s"), LoginError);
});

test("redaction hides every known secret", () => {
  const r = makeRedactor(() => ["SECRET-ONE", "tok-two-xxx"]);
  assert.equal(
    r("a SECRET-ONE b tok-two-xxx c"),
    "a [redacted] b [redacted] c",
  );
});

test("code exchange uses the verifier and never leaks the body on failure", async () => {
  let sent;
  const ok = await exchangeCode({
    fetchImpl: async (url, init) => {
      sent = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ refresh_token: "RT" }),
      };
    },
    domain: "t",
    clientId: "c",
    clientSecret: "s",
    code: "code",
    verifier: "ver",
  });
  assert.equal(ok, "RT");
  assert.equal(sent.code_verifier, "ver");
  await assert.rejects(
    exchangeCode({
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: "access_denied", secret: "LEAK" }),
      }),
      domain: "t",
      clientId: "c",
      clientSecret: "s",
      code: "x",
      verifier: "v",
    }),
    (e) => /403: access_denied/.test(e.message) && !/LEAK/.test(e.message),
  );
  await assert.rejects(
    exchangeCode({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      }),
      domain: "t",
      clientId: "c",
      clientSecret: "s",
      code: "x",
      verifier: "v",
    }),
    /no refresh token/,
  );
});

function fakeListen() {
  let handler;
  const server = new EventEmitter();
  server.close = () => (server.closed = true);
  server.start = () => {};
  const listen = (h) => ((handler = h), server);
  const hit = (url) => {
    const res = { writeHead() {}, end() {} };
    handler({ url }, res);
  };
  return { listen, server, hit };
}

test("waitForCallback resolves on a valid callback, rejects on mismatch, port-in-use and timeout", async () => {
  const a = fakeListen();
  const p = waitForCallback({ listen: a.listen, state: "s", timeoutMs: 1000 });
  a.hit("/callback?code=C&state=s");
  assert.equal(await p, "C");
  assert.equal(a.server.closed, true);

  const b = fakeListen();
  const pb = waitForCallback({ listen: b.listen, state: "s", timeoutMs: 1000 });
  b.hit("/callback?code=C&state=bad");
  await assert.rejects(pb, /State mismatch/);

  const c = fakeListen();
  const pc = waitForCallback({ listen: c.listen, state: "s", timeoutMs: 1000 });
  c.server.emit("error", Object.assign(new Error("x"), { code: "EADDRINUSE" }));
  await assert.rejects(pc, /already in use/);

  const d = fakeListen();
  let fire;
  const pd = waitForCallback({
    listen: d.listen,
    state: "s",
    timeoutMs: 300000,
    setTimer: (f) => ((fire = f), 1),
    clear: () => {},
  });
  fire();
  await assert.rejects(pd, /Timed out after 5 minutes/);
});

test("parseArgs bounds the timeout", () => {
  assert.equal(parseArgs([], "/h").timeoutMin, 5);
  assert.throws(() => parseArgs(["--timeout-min", "99"]), /1-30/);
  assert.throws(() => parseArgs(["--nope"]), /Unknown/);
});

test("main: end to end with injected fetch/opener/listener; secrets only reach putSecret", async () => {
  const out = [];
  const errs = [];
  const l = fakeListen();
  let opened;
  let stored;
  let exchangeBody;
  const code = await main([], {
    out: (x) => out.push(x),
    err: (x) => errs.push(x),
    readState: () => STATE,
    open: (url) => {
      opened = url;
      const st = new URL(url).searchParams.get("state");
      queueMicrotask(() => l.hit(`/callback?code=AUTHCODE-123&state=${st}`));
    },
    listen: l.listen,
    fetchImpl: async (_u, init) => {
      exchangeBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ refresh_token: "REFRESH-TOKEN-XYZ" }),
      };
    },
    putSecret: async (v) => ((stored = v), { code: 0, stderr: "" }),
  });
  assert.equal(code, 0, errs.join("\n"));
  assert.equal(stored, "REFRESH-TOKEN-XYZ");
  assert.equal(exchangeBody.client_secret, "CLIENT-SECRET-VALUE");
  assert.ok(opened.startsWith("https://t.us.auth0.com/authorize?"));
  const all = [...out, ...errs].join("\n");
  for (const s of [
    "REFRESH-TOKEN-XYZ",
    "CLIENT-SECRET-VALUE",
    "ALEX-PASSWORD-VALUE",
    "AUTHCODE-123",
  ])
    assert.ok(!all.includes(s), `${s} leaked`);
  assert.match(all, /alex@example\.com/);
  assert.match(all, /auth0-state\.json/);
});

test("main: failures are reported clearly and exit 1 without storing anything", async () => {
  const run = async (over) => {
    const out = [];
    const errs = [];
    const l = fakeListen();
    let stored = false;
    const code = await main([], {
      out: (x) => out.push(x),
      err: (x) => errs.push(x),
      readState: () => STATE,
      open: (url) => {
        const st = new URL(url).searchParams.get("state");
        queueMicrotask(() =>
          l.hit(`/callback?code=C&state=${over.state ?? st}`),
        );
      },
      listen: l.listen,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ refresh_token: "RT-SECRET" }),
      }),
      putSecret: async () => (
        (stored = true),
        { code: over.putCode ?? 0, stderr: "RT-SECRET leaked?" }
      ),
      ...over.deps,
    });
    return { code, errs: errs.join("\n"), stored };
  };
  const mismatch = await run({ state: "evil" });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.errs, /State mismatch/);
  assert.equal(mismatch.stored, false);
  const wrangler = await run({ putCode: 1 });
  assert.equal(wrangler.code, 1);
  assert.match(wrangler.errs, /wrangler secret put failed/);
  assert.doesNotMatch(wrangler.errs, /RT-SECRET/);
  const nostate = await run({ deps: { readState: () => ({}) } });
  assert.match(nostate.errs, /lacks the Agent Owner client/);
});
