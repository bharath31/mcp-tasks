#!/usr/bin/env node
// One-time login of the delegating user (policy-desk-alex) to obtain an offline refresh token, which is
// piped straight into `wrangler secret put AGENT_OWNER_REFRESH_TOKEN` over stdin. Order of operations:
//   1. provision.mjs --apply --create-alex <email>     2. put-secrets.mjs --apply     3. this script
//
//   node demo/policy-desk/tools/alex-login.mjs [--state ~/.policy-desk/auth0-state.json] [--timeout-min 5]
//
// Authorization Code + PKCE through the confidential "Policy Desk Agent Owner" client, with a loopback
// listener on 127.0.0.1:53682. The code, the client secret, the refresh token and Alex's password are never
// printed, logged or written to disk; the refresh token's only destination is the Worker secret store.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PORT = 53682;
export const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
export const SECRET_NAME = "AGENT_OWNER_REFRESH_TOKEN";

export class LoginError extends Error {}

const b64url = (b) => Buffer.from(b).toString("base64url");

export function makePkce(random = randomBytes) {
  const verifier = b64url(random(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, state: b64url(random(24)) };
}

export function buildAuthorizeUrl({
  domain,
  clientId,
  orgId,
  audience,
  state,
  challenge,
}) {
  const u = new URL(`https://${domain}/authorize`);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid offline_access",
    audience,
    organization: orgId,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

/** Validates the redirect Auth0 sends to the loopback listener. Returns the code. */
export function parseCallback(requestUrl, expectedState) {
  const u = new URL(requestUrl, `http://127.0.0.1:${PORT}`);
  if (u.pathname !== "/callback") throw new LoginError("unexpected path");
  const err = u.searchParams.get("error");
  if (err)
    throw new LoginError(
      `Auth0 returned an error: ${err}${u.searchParams.get("error_description") ? ` (${u.searchParams.get("error_description")})` : ""}`,
    );
  if (u.searchParams.get("state") !== expectedState)
    throw new LoginError(
      "State mismatch: this callback does not belong to the login this script started. Nothing was stored.",
    );
  const code = u.searchParams.get("code");
  if (!code)
    throw new LoginError("The callback carried no authorization code.");
  return code;
}

export function makeRedactor(secrets) {
  const list = () =>
    secrets().filter((s) => typeof s === "string" && s.length >= 6);
  return (text) => {
    let out = String(text);
    for (const s of list()) out = out.split(s).join("[redacted]");
    return out;
  };
}

export async function exchangeCode({
  fetchImpl,
  domain,
  clientId,
  clientSecret,
  code,
  verifier,
}) {
  let res;
  try {
    res = await fetchImpl(`https://${domain}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
    });
  } catch {
    throw new LoginError("Could not reach the Auth0 token endpoint.");
  }
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok)
    throw new LoginError(
      `Token exchange failed (${res.status}${body.error ? `: ${body.error}` : ""}).`,
    );
  if (!body.refresh_token)
    throw new LoginError(
      "Auth0 returned no refresh token. Check that the API allows offline access and that the sign-in used the organization.",
    );
  return body.refresh_token;
}

/** Waits for exactly one valid callback on the loopback port. */
export function waitForCallback({
  listen,
  state,
  timeoutMs,
  setTimer = setTimeout,
  clear = clearTimeout,
}) {
  return new Promise((resolveP, rejectP) => {
    let server;
    let timer;
    const finish = (fn, v) => {
      clear(timer);
      server?.close?.();
      fn(v);
    };
    server = listen((req, res) => {
      let code;
      try {
        code = parseCallback(req.url ?? "", state);
      } catch (e) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(
          "Sign-in failed. You can close this tab and read the terminal.",
        );
        return finish(rejectP, e);
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Signed in. You can close this tab and return to the terminal.");
      finish(resolveP, code);
    });
    server.on?.("error", (e) =>
      finish(
        rejectP,
        new LoginError(
          e?.code === "EADDRINUSE"
            ? `Port ${PORT} is already in use. Stop whatever is listening there and retry.`
            : `Could not listen on 127.0.0.1:${PORT}: ${e?.code ?? "error"}`,
        ),
      ),
    );
    timer = setTimer(
      () =>
        finish(
          rejectP,
          new LoginError(
            `Timed out after ${Math.round(timeoutMs / 60000)} minutes without a sign-in.`,
          ),
        ),
      timeoutMs,
    );
    server.start?.();
  });
}

export function realListen(handler) {
  const server = createServer(handler);
  server.start = () => server.listen(PORT, "127.0.0.1");
  return server;
}

export function realOpen(url) {
  const bin =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(bin, args, { stdio: "ignore", detached: true }).unref();
}

/** `wrangler secret put` with the value on stdin only. Returns {code, stderr (scrubbed by the caller)}. */
export function realPutSecret(value, config) {
  return new Promise((res) => {
    const child = spawn(
      "npx",
      ["wrangler", "secret", "put", SECRET_NAME, "--config", config],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", () => {});
    child.on("close", (code) => res({ code, stderr }));
    child.stdin.end(value);
  });
}

export function parseArgs(argv, home = homedir()) {
  const o = {
    state: resolve(home, ".policy-desk/auth0-state.json"),
    timeoutMin: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--state") o.state = resolve(argv[++i] ?? "");
    else if (a === "--timeout-min") o.timeoutMin = Number(argv[++i]);
    else throw new LoginError(`Unknown argument: ${a}`);
  }
  if (!(o.timeoutMin > 0 && o.timeoutMin <= 30))
    throw new LoginError("--timeout-min must be 1-30");
  return o;
}

export async function main(argv, depsIn = {}) {
  const deps = {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    readState: (p) => JSON.parse(readFileSync(p, "utf8")),
    fetchImpl: fetch,
    open: realOpen,
    listen: realListen,
    putSecret: (v) => realPutSecret(v, resolve(HERE, "../wrangler.jsonc")),
    random: randomBytes,
    timers: {},
    ...depsIn,
  };
  const known = [];
  const redact = makeRedactor(() => known);
  const say = (l) => deps.out(redact(l));
  const fail = (l) => deps.err(redact(l));
  try {
    const o = parseArgs(argv);
    let state;
    try {
      state = deps.readState(o.state);
    } catch {
      throw new LoginError(
        `Could not read the state file ${o.state}. Run provision.mjs --apply first.`,
      );
    }
    const owner = state.clients?.agentOwner;
    const domain = state.tenant;
    const audience = state.resourceServer?.identifier;
    const orgId = state.organization?.id;
    if (
      !owner?.client_id ||
      !owner?.client_secret ||
      !domain ||
      !audience ||
      !orgId
    )
      throw new LoginError(
        "The state file lacks the Agent Owner client, tenant, organization or audience. Re-run provision.mjs --apply (without --destroy).",
      );
    known.push(owner.client_secret, state.alex?.password);
    const { verifier, challenge, state: st } = makePkce(deps.random);
    known.push(verifier);
    const url = buildAuthorizeUrl({
      domain,
      clientId: owner.client_id,
      orgId,
      audience,
      state: st,
      challenge,
    });
    say("Opening your browser to sign in as the delegating user.");
    say(`Sign in as: ${state.alex?.email ?? "policy-desk-alex (its email)"}`);
    say(
      state.alex?.password
        ? `Its password is in ${o.state} (alex.password). It is not printed here.`
        : 'No password is recorded in the state file; use "Forgot password" on the login page to set one.',
    );
    say(
      "If the browser does not open, copy this URL (it contains no secrets):",
    );
    say(url);
    const waiting = waitForCallback({
      listen: deps.listen,
      state: st,
      timeoutMs: o.timeoutMin * 60_000,
      ...deps.timers,
    });
    try {
      deps.open(url);
    } catch {
      say("Could not open a browser automatically; use the URL above.");
    }
    const code = await waiting;
    known.push(code);
    const refresh = await exchangeCode({
      fetchImpl: deps.fetchImpl,
      domain,
      clientId: owner.client_id,
      clientSecret: owner.client_secret,
      code,
      verifier,
    });
    known.push(refresh);
    const r = await deps.putSecret(refresh);
    if (r.code !== 0) {
      fail(
        `wrangler secret put failed (exit ${r.code}). Is the Worker deployed? ${(r.stderr || "").split("\n").slice(-3).join(" ")}`,
      );
      return 1;
    }
    say(
      `Stored ${SECRET_NAME} as a Worker secret. The token itself was not shown or saved anywhere else.`,
    );
    return 0;
  } catch (e) {
    fail(
      e instanceof LoginError ? e.message : "Unexpected error during sign-in.",
    );
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
