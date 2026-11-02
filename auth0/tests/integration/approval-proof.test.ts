import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import {
  actionDigest,
  approvalConfig,
  approvalLink,
  handleApprovalRoute,
  type ApprovalRequest,
  type Delivery,
} from "@task-authority/sdk/approve";
import { Agent, fetch as undiciFetch } from "undici";
import {
  MFA_CODE,
  startOidcServer,
  type OidcServer,
} from "../helpers/oidc-server.js";
import { createWorld, ORG, PEOPLE, type World } from "../helpers/world.js";

const require = createRequire(import.meta.url);
const APP = "https://approval-proof.test";
const CLIENT_ID = "approvals";
const CLIENT_SECRET = "approval-proof-secret";
let oidc: OidcServer;
let world: World;
let cfg: ReturnType<typeof approvalConfig>;
let tlsFetch: typeof fetch;

before(async () => {
  oidc = await startOidcServer({
    users: [
      { key: "morgan", sub: PEOPLE.morgan, name: "Morgan", org: ORG.northstar },
      { key: "eve", sub: PEOPLE.eve, name: "Eve", org: ORG.northstar },
    ],
    clients: [
      {
        id: CLIENT_ID,
        secret: CLIENT_SECRET,
        redirectUris: [`${APP}/approve/callback`],
      },
    ],
    resourceAudiences: ["https://approval-proof.test/task-authority"],
    postLoginActions: [require("../../actions/agent-approval.cjs")],
  });
  const agent = new Agent({ connect: { ca: readFileSync(oidc.caPath) } });
  tlsFetch = ((u: string | URL | Request, init?: RequestInit) =>
    undiciFetch(u as string, {
      ...(init as any),
      dispatcher: agent,
    })) as unknown as typeof fetch;
  world = await createWorld({ oidc, liveClock: true });
  world.tenant.approvalClientId = CLIENT_ID;
  world.tenant.approvalFetch = tlsFetch;
  cfg = approvalConfig(
    {},
    {
      domain: oidc.domain,
      issuer: oidc.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      appUrl: APP,
      fetch: tlsFetch,
    },
  );
});
after(async () => {
  await world?.close();
  await oidc?.close();
});

async function createProof(request: ApprovalRequest, user: "morgan" | "eve") {
  const link = await approvalLink(cfg, request);
  const deliveries: Delivery[] = [];
  const route = (req: Request) =>
    handleApprovalRoute(req, cfg, {
      deliver: async (d) => void deliveries.push(d),
    });
  const page = await route(new Request(link));
  assert.equal(page?.status, 200);
  const started = await route(
    new Request(`${APP}/approve`, {
      method: "POST",
      body: new URLSearchParams({
        r: new URL(link).searchParams.get("r")!,
        decision: "approve",
      }),
    }),
  );
  assert.equal(started?.status, 303);
  const authorize = new URL(started!.headers.get("location")!);
  const login = await tlsFetch(`${oidc.issuer}authorize`, {
    method: "POST",
    body: new URLSearchParams({
      ...Object.fromEntries(authorize.searchParams),
      _user: user,
      _method: "passkey",
      _mfa: MFA_CODE,
    }),
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  const callback = await route(new Request(login.headers.get("location")!));
  assert.equal(
    callback?.status,
    200,
    (await callback?.clone().text()) ?? "no callback response",
  );
  assert.equal(deliveries.length, 1);
  return deliveries[0]!.proof;
}

test("a verified approve() proof is written as a current Task Authority reviewer decision", async () => {
  const { op, ap } = await world.exception();
  const version = op.digest;
  const args = op.arguments as ApprovalRequest["args"];
  const request: ApprovalRequest = {
    v: 1,
    id: ap.id,
    action: op.action,
    resource: op.resource,
    args,
    version,
    digest: await actionDigest({
      action: op.action,
      resource: op.resource,
      args,
      version,
    }),
    run: op.id,
    step: ap.id,
    approvers: { users: [PEOPLE.morgan] },
    requester: PEOPLE.alice,
    via: "link",
    iat: Math.floor(Date.parse(ap.requestedAt) / 1000),
    exp: Math.floor(Date.parse(ap.expiresAt) / 1000),
  };
  const proof = await createProof(request, "morgan");
  const result = await world.call("POST", `/v1/approvals/${ap.id}/proof`, {
    token: await world.tok.api(),
    idem: "approval-proof-morgan-001",
    body: { proof },
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.status, "approved");
  const stored = await world.store.pool.query(
    "select approver_id, assurance from authority.approvals where id=$1",
    [ap.id],
  );
  assert.equal(stored.rows[0]!.approver_id, PEOPLE.morgan);
  assert.equal(stored.rows[0]!.assurance.approvalMethod, "passkey");
  assert.ok(Number(stored.rows[0]!.assurance.authTime) > 0);

  // A second request carrying the same signed proof is an idempotent replay.
  const replay = await world.call("POST", `/v1/approvals/${ap.id}/proof`, {
    token: await world.tok.api(),
    idem: "approval-proof-morgan-002",
    body: { proof },
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
});

test("a signed proof from someone outside the FGA reviewer relation cannot decide the row", async () => {
  const { op, ap } = await world.exception();
  const version = op.digest;
  const args = op.arguments as ApprovalRequest["args"];
  const request: ApprovalRequest = {
    v: 1,
    id: ap.id,
    action: op.action,
    resource: op.resource,
    args,
    version,
    digest: await actionDigest({
      action: op.action,
      resource: op.resource,
      args,
      version,
    }),
    run: op.id,
    step: ap.id,
    approvers: { users: [PEOPLE.eve] },
    requester: PEOPLE.alice,
    via: "link",
    iat: Math.floor(Date.parse(ap.requestedAt) / 1000),
    exp: Math.floor(Date.parse(ap.expiresAt) / 1000),
  };
  const proof = await createProof(request, "eve");
  const denied = await world.call("POST", `/v1/approvals/${ap.id}/proof`, {
    token: await world.tok.api(),
    body: { proof },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.details?.reason, "not_org_approver");
});
