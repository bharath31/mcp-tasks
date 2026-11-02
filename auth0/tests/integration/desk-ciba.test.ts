// The refund-desk worker settles escalated CIBA approvals by itself (no test-only polling).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createDesk,
  MCP_AUDIENCE,
  MCP_CLIENT,
  type Desk,
} from "../helpers/desk.js";
import {
  startOidcServer,
  type OidcServer,
  type OidcUser,
} from "../helpers/oidc-server.js";
import { ORG, PEOPLE, createWorld } from "../helpers/world.js";

let d: Desk;
let oidc: OidcServer;
before(async () => {
  oidc = await startOidcServer({
    users: ([PEOPLE.morgan, PEOPLE.alice] as string[]).map((sub): OidcUser => ({
      key: sub,
      sub,
      name: sub,
      org: ORG.northstar,
    })),
    clients: [{ id: "authority-ciba", secret: "ciba-secret" }],
    resourceAudiences: ["https://task-authority.example/api"],
  });
  const w = await createWorld({ oidc });
  w.tenant.ciba = {
    bcAuthorizeUrl: `${oidc.issuer}bc-authorize`,
    tokenUrl: `${oidc.issuer}oauth/token`,
    clientId: "authority-ciba",
    clientSecret: "ciba-secret",
    audience: w.idp.audience,
    issuer: oidc.issuer,
  };
  d = await createDesk(w);
});
after(async () => {
  await d?.close();
  await oidc?.close();
});

test("the worker polls an escalated CIBA approval and the refund executes once the reviewer approves", async () => {
  const paymentId = await d.payment();
  const created = await d.refund({
    paymentId,
    orderId: "CIBA-1",
    amountMinor: 15000,
    note: "Damaged on arrival, RMA verified.",
    // The desk trusts its own test domain; the authority trusts the local OIDC provider's issuer.
    token: await d.w.idp.mint({
      sub: PEOPLE.alice,
      orgId: ORG.northstar,
      azp: MCP_CLIENT,
      audience: MCP_AUDIENCE,
      issuer: "https://test-tenant.example/",
      iat: Math.floor(Date.now() / 1000),
    }),
  });
  assert.ok(created.body.result, JSON.stringify(created.body));
  const taskId: string = created.body.result.taskId;
  assert.ok(taskId, JSON.stringify(created.body));
  await d.warehouse("CIBA-1", paymentId);
  await d.step(0); // worker requests the portal approval now that the return is verified
  const op = await d.authority.operations.get(
    (await d.repo.get(taskId))!.operationId!,
  );
  assert.equal(op.approvalStatus, "pending");
  const escalated = await d.w.call(
    "POST",
    `/v1/approval-requests/${op.approvalId}/escalate`,
    {
      token: await d.w.tok.api(),
      body: { reviewerSubject: PEOPLE.morgan },
    },
  );
  assert.equal(escalated.status, 200, JSON.stringify(escalated.json));
  const [authReqId] = [...oidc.cibaRequests.keys()];
  await d.step(0);
  assert.equal(d.payments.calls.length, 0, "still waiting for the reviewer");
  assert.ok(oidc.cibaDecide(authReqId!, true));
  for (let i = 0; i < 6 && d.payments.calls.length === 0; i++)
    await d.step(16_000);
  assert.equal(d.payments.calls.length, 1);
  assert.equal((await d.repo.get(taskId))!.status, "completed");
});
