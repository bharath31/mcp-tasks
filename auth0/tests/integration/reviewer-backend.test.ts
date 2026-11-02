import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskAuthority } from "@task-authority/sdk";
import { ReviewerBackend } from "../../../demo/refund-desk/src/reviewer.js";

function fixture() {
  const oauth: Array<{ path: string; params: URLSearchParams }> = [];
  const service: Array<{ path: string; headers: Headers; body: any }> = [];
  const authority = new TaskAuthority({
    baseUrl: "https://authority.test",
    getAccessToken: async () => "backend-token",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      service.push({
        path,
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path.endsWith("/decisions"))
        return Response.json({
          approvals: [{ id: "ap_1", status: "approved" }],
        });
      return Response.json({
        id: path.split("/").at(-1),
        operationDigest: "sha256:exact",
        status: "pending",
        operation: {
          action: "refund:create",
          organizationId: "org_northstar",
          resource: "payment:1",
          arguments: { amountMinor: 150000 },
        },
      });
    },
  });
  const backend = new ReviewerBackend({
    domain: "issuer.test",
    clientId: "confidential",
    clientSecret: "secret-is-server-side",
    audience: "https://authority.test/api",
    publicUrl: "https://refund.test",
    authority,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      oauth.push({ path, params: new URLSearchParams(String(init?.body)) });
      return Response.json(
        path === "/oauth/par"
          ? { request_uri: "urn:par:opaque", expires_in: 30 }
          : { access_token: "reviewer-secret-token" },
      );
    },
  });
  const request = (
    path: string,
    options: { body?: unknown; cookie?: string; origin?: string } = {},
  ) =>
    backend.handle(
      new Request(`https://refund.test${path}`, {
        method: options.body === undefined ? "GET" : "POST",
        headers: {
          ...(options.body === undefined
            ? {}
            : {
                "content-type": "application/json",
                origin: options.origin ?? "https://refund.test",
              }),
          ...(options.cookie ? { cookie: options.cookie } : {}),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    );
  return { backend, oauth, service, request };
}

test("confidential backend pushes exact digest details via PAR and keeps secret and reviewer token out of browser responses", async () => {
  const f = fixture();
  const start = await f.request("/api/reviewer/par", {
    body: { approvalIds: ["ap_1", "ap_2"] },
  });
  assert.equal(start.status, 200);
  const authorization = (await start.json()).authorizationUrl;
  assert.deepEqual(
    [...new URL(authorization).searchParams.keys()],
    ["client_id", "request_uri"],
  );
  assert.ok(!authorization.includes("secret"));
  assert.equal(f.oauth[0]!.path, "/oauth/par");
  assert.equal(
    f.oauth[0]!.params.get("client_secret"),
    "secret-is-server-side",
  );
  assert.equal(f.oauth[0]!.params.get("code_challenge_method"), "S256");
  assert.deepEqual(
    JSON.parse(f.oauth[0]!.params.get("authorization_details")!),
    [
      {
        type: "task_authority_approval",
        approval_id: "ap_1",
        operation_digest: "sha256:exact",
      },
      {
        type: "task_authority_approval",
        approval_id: "ap_2",
        operation_digest: "sha256:exact",
      },
    ],
  );
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(start.headers.get("set-cookie")!, /HttpOnly/);
  const state = f.oauth[0]!.params.get("state");
  const bad = await f.request(`/api/reviewer/callback?state=wrong&code=code`, {
    cookie,
  });
  assert.equal(bad.status, 400);
  assert.equal(f.oauth.length, 1);
  const callback = await f.request(
    `/api/reviewer/callback?state=${state}&code=one-use-code`,
    { cookie },
  );
  assert.equal(callback.status, 303);
  assert.match(callback.headers.get("location")!, /transaction=ready/);
  assert.equal(f.oauth[1]!.params.get("grant_type"), "authorization_code");
  assert.ok(f.oauth[1]!.params.has("code_verifier"));
  const view = await f.request("/api/reviewer/transaction", { cookie });
  assert.ok(!(await view.text()).includes("reviewer-secret-token"));
  const decided = await f.request("/api/reviewer/decision", {
    cookie,
    body: { decision: "approve" },
  });
  assert.equal(decided.status, 200);
  const sent = f.service.at(-1)!;
  assert.equal(
    sent.headers.get("authorization"),
    "Bearer reviewer-secret-token",
  );
  assert.equal(sent.body.decisions.length, 2);
  assert.equal(
    (
      await f.request("/api/reviewer/decision", {
        cookie,
        body: { decision: "approve" },
      })
    ).status,
    401,
  );
});

test("reviewer backend refuses cross-origin initiation, over-large batches and callback without its state cookie", async () => {
  const f = fixture();
  assert.equal(
    (
      await f.request("/api/reviewer/par", {
        body: { approvalIds: ["ap_1"] },
        origin: "https://attacker.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/reviewer/par", {
        body: { approvalIds: ["1", "2", "3", "4", "5", "6"] },
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request("/api/reviewer/callback?state=fake&code=fake")).status,
    401,
  );
  assert.equal(f.oauth.length, 0);
});
