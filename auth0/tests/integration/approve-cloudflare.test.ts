// approve() inside a real Cloudflare Workflow: workerd under Miniflare runs the
// workflow, its step.waitForEvent and the approval routes; the local OIDC provider
// signs the proofs over real HTTPS. Pins: anyone can send the engine an event, but
// only a verified passkey decision moves the run, and a refused one doesn't end it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { decodeJwt } from "jose";
import {
  Miniflare,
  Response as MfResponse,
  convertV4MiniflareOptions,
} from "miniflare";
import { Agent, fetch as undiciFetch } from "undici";
import { approvalEventType } from "@task-authority/sdk/approve/cloudflare";
import { startOidcServer, type OidcServer } from "../helpers/oidc-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const APP = "https://refunds.test";

let oidc: OidcServer;
let mf: Miniflare;
let idp: typeof fetch;

before(async () => {
  oidc = await startOidcServer({
    users: [
      {
        key: "alice",
        sub: "auth0|alice",
        name: "Alice Finance",
        org: "o",
        roles: ["finance"],
      },
      { key: "bob", sub: "auth0|bob", name: "Bob", org: "o" },
    ],
    clients: [
      {
        id: "approvals",
        secret: "s3cret-s3cret",
        redirectUris: [`${APP}/approve/callback`],
      },
    ],
    resourceAudiences: ["https://refunds.test/api"],
    postLoginActions: [require("../../actions/agent-approval.cjs")],
  });
  const agent = new Agent({ connect: { ca: readFileSync(oidc.caPath) } });
  idp = ((u: string, init?: object) =>
    undiciFetch(u, { ...init, dispatcher: agent })) as unknown as typeof fetch;
  const bundle = await build({
    entryPoints: [join(here, "../../../demo/refund-workflow/src/worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    target: "es2023",
  });
  const options = convertV4MiniflareOptions({
    workers: [
      {
        name: "refunds",
        modules: true,
        script: bundle.outputFiles[0]!.text,
        compatibilityDate: "2026-10-09",
        kvNamespaces: ["LINKS"],
        workflows: {
          REFUNDS: { name: "refunds", className: "RefundWorkflow" },
        },
        bindings: {
          AUTH0_DOMAIN: oidc.domain,
          AUTH0_CLIENT_ID: "approvals",
          AUTH0_CLIENT_SECRET: "s3cret-s3cret",
          APP_URL: APP,
        },
      },
    ],
  });
  // The Worker's outbound fetches (JWKS, token endpoint) go to the local IdP over TLS,
  // trusting only its self-signed certificate.
  options.workers[0]!.dev = {
    ...options.workers[0]!.dev,
    outboundService: {
      type: "fetcher",
      handler: async (req) => {
        const body = ["GET", "HEAD"].includes(req.method)
          ? undefined
          : await req.arrayBuffer();
        const res = await undiciFetch(req.url, {
          method: req.method,
          headers: [...req.headers] as [string, string][],
          body,
          redirect: "manual",
          dispatcher: agent,
        });
        return new MfResponse(await res.arrayBuffer(), {
          status: res.status,
          headers: [...res.headers] as [string, string][],
        });
      },
    },
  };
  mf = new Miniflare(options);
  await mf.ready;
});
after(async () => {
  await mf?.dispose();
  await oidc?.close();
});

const worker = (path: string, init?: RequestInit) =>
  mf.dispatchFetch(
    new URL(path, APP),
    init as never,
  ) as unknown as Promise<Response>;

async function until<T>(fn: () => Promise<T | null | undefined>, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const status = async (id: string) =>
  (await (await worker(`/api/refunds/${id}`)).json()) as {
    status: string;
    output?: Record<string, unknown>;
    error?: unknown;
    link: string | null;
  };

/** Anyone who can reach the engine: send an event straight to the Workflow binding. */
async function sendEvent(id: string, type: string, payload: unknown) {
  const { REFUNDS } = (await mf.getBindings()) as {
    REFUNDS: {
      get(id: string): Promise<{
        sendEvent(e: { type: string; payload: unknown }): Promise<void>;
      }>;
    };
  };
  await (await REFUNDS.get(id)).sendEvent({ type, payload });
}

async function startRefund(paymentId: string) {
  const { id } = (await (
    await worker("/api/refunds", {
      method: "POST",
      body: JSON.stringify({ paymentId, amountMinor: 15000 }),
    })
  ).json()) as { id: string };
  const link = await until(async () => (await status(id)).link);
  const request = decodeJwt(new URL(link).searchParams.get("r")!).r as {
    id: string;
  };
  return { id, link, type: approvalEventType(request) };
}

/** The approver's browser: page, button, IdP sign-in, callback. */
async function decide(link: string, decision: string, user: string) {
  assert.equal((await worker(link)).status, 200);
  const start = await worker("/approve", {
    method: "POST",
    body: new URLSearchParams({
      r: new URL(link).searchParams.get("r")!,
      decision,
    }),
    redirect: "manual",
  });
  assert.equal(start.status, 303);
  const authorize = new URL(start.headers.get("location")!);
  const login = await idp(`${oidc.issuer}authorize`, {
    method: "POST",
    body: new URLSearchParams({
      ...Object.fromEntries(authorize.searchParams),
      _user: user,
      _method: "passkey",
    }),
    redirect: "manual",
  });
  const res = await worker(login.headers.get("location")!);
  return { status: res.status, body: await res.text() };
}

test("a forged event can't approve or end the run; a passkey decision completes it once", async () => {
  const { id, link, type } = await startRefund("pay_cf_1");
  await until(async () =>
    ["waiting", "running"].includes((await status(id)).status) ? true : null,
  );

  // The demo's own "forged approval" button, then a raw event with no proof at all.
  const forged = await worker(`/api/refunds/${id}/forge`, {
    method: "POST",
    body: JSON.stringify({ type }),
  });
  assert.equal(forged.status, 204);
  await sendEvent(id, type, { approved: true, approvedBy: "auth0|alice" });
  await new Promise((r) => setTimeout(r, 1500));
  assert.notEqual((await status(id)).status, "complete");
  assert.notEqual((await status(id)).status, "errored");

  // Bob has no finance role: refused at the callback, and the run keeps waiting.
  const bob = await decide(link, "approve", "bob");
  assert.equal(bob.status, 403);

  const alice = await decide(link, "approve", "alice");
  assert.equal(alice.status, 200, alice.body);
  const done = await until(async () => {
    const s = await status(id);
    return s.status === "complete" ? s : null;
  });
  assert.equal(done.output?.status, "refunded");
  assert.equal(done.output?.approvedBy, "auth0|alice");
  assert.equal(done.output?.method, "passkey");
  const refund = done.output?.refund as { idempotencyKey: string };
  assert.match(refund.idempotencyKey, /^apv_/);
});

test("a real proof for one run can't approve another", async () => {
  const a = await startRefund("pay_cf_2");
  const b = await startRefund("pay_cf_2");
  await until(async () =>
    ["waiting", "running"].includes((await status(b.id)).status) ? true : null,
  );
  // Alice's genuine, Auth0-signed approval of run A, replayed at run B (same arguments).
  const proof = await signInForProof(a.link);
  assert.ok(proof);
  await sendEvent(b.id, b.type, { proof });
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(["waiting", "running"].includes((await status(b.id)).status));
  // Delivered to its own run, the same proof completes it.
  await sendEvent(a.id, a.type, { proof });
  const doneA = await until(async () => {
    const s = await status(a.id);
    return s.status === "complete" ? s : null;
  });
  assert.equal(doneA.output?.status, "refunded");
});

test("a verified rejection ends the run without refunding", async () => {
  const { id, link } = await startRefund("pay_cf_3");
  const res = await decide(link, "reject", "alice");
  assert.equal(res.status, 200);
  const done = await until(async () => {
    const s = await status(id);
    return s.status === "complete" ? s : null;
  });
  assert.deepEqual(done.output, { status: "rejected", by: "auth0|alice" });
});

/** Signs in for a link's approve decision and returns the ID token, without delivering it. */
async function signInForProof(link: string) {
  const start = await worker("/approve", {
    method: "POST",
    body: new URLSearchParams({
      r: new URL(link).searchParams.get("r")!,
      decision: "approve",
    }),
    redirect: "manual",
  });
  const authorize = new URL(start.headers.get("location")!);
  // Captured off the wire: drop PKCE so this test can redeem the code itself.
  authorize.searchParams.delete("code_challenge");
  authorize.searchParams.delete("code_challenge_method");
  const login = await idp(`${oidc.issuer}authorize`, {
    method: "POST",
    body: new URLSearchParams({
      ...Object.fromEntries(authorize.searchParams),
      _user: "alice",
      _method: "passkey",
    }),
    redirect: "manual",
  });
  const code = new URL(login.headers.get("location")!).searchParams.get(
    "code",
  )!;
  const token = (await (
    await idp(`${oidc.issuer}oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "approvals",
        client_secret: "s3cret-s3cret",
        code,
        redirect_uri: `${APP}/approve/callback`,
      }),
    })
  ).json()) as { id_token?: string; error?: string };
  return token.id_token;
}
