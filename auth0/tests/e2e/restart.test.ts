// REAL process restarts: the customer app runs as a child process, is SIGKILLed
// mid-flow while the MCP client is gone, and a new process resumes from the
// customer's database and the separately hosted Task Authority service.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { SimulatedPayments } from "../../../demo/refund-desk/src/payments.js";
import { Repository } from "../../../demo/refund-desk/src/repository.js";
import { signWarehouseBody } from "../../../demo/refund-desk/src/warehouse.js";
import { listen } from "../../service/src/server.js";
import {
  MCP_AUDIENCE,
  MCP_CLIENT,
  WAREHOUSE_SECRET,
  seedDeskPolicy,
} from "../helpers/desk.js";
import { createTestDb } from "../helpers/pg.js";
import { ORG, PEOPLE, createWorld, type World } from "../helpers/world.js";
import { TaskAuthority } from "@task-authority/sdk";

let w: World;
let authorityServer: Awaited<ReturnType<typeof listen>>;
let authorityUrl: string;
let db: Awaited<ReturnType<typeof createTestDb>>;
let repo: Repository;
let payments: SimulatedPayments;
const children: ChildProcess[] = [];

before(async () => {
  w = await createWorld({ liveClock: true });
  await seedDeskPolicy(
    w.store.pool,
    w.tenant.tenantId,
    MCP_AUDIENCE,
    w.clock.now(),
  );
  authorityServer = await listen(w.handle, 0);
  authorityUrl = `http://127.0.0.1:${(authorityServer.address() as AddressInfo).port}`;
  db = await createTestDb("rd");
  repo = new Repository(new pg.Pool({ connectionString: db.url, max: 4 }));
  await repo.migrate();
  payments = new SimulatedPayments(repo.pool);
});
after(async () => {
  for (const c of children) c.kill("SIGKILL");
  authorityServer.close();
  await repo.close();
  await db.drop();
  await w.close();
});

async function startApp() {
  const child = spawn(
    "node",
    ["--import", "tsx", "tests/helpers/desk-child.ts"],
    {
      cwd: new URL("../../", import.meta.url).pathname,
      env: {
        ...process.env,
        DESK_DB_URL: db.url,
        AUTHORITY_URL: authorityUrl,
        IDP_PRIVATE_JWK: JSON.stringify(w.idp.privateJwk),
        IDP_PUBLIC_JWK: JSON.stringify(w.idp.jwk),
        MCP_AUDIENCE,
        WAREHOUSE_SECRET,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.once("exit", (code) =>
      reject(new Error(`child exited early (${code})`)),
    );
    child.stdout!.on("data", (b: Buffer) => {
      for (const line of b.toString().split("\n"))
        if (line.includes('"ready"')) resolve(JSON.parse(line).port);
    });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

const mcpToken = (sub: string) =>
  w.idp.mint({
    sub,
    orgId: ORG.northstar,
    azp: MCP_CLIENT,
    audience: MCP_AUDIENCE,
    iat: Math.floor(Date.now() / 1000),
  });
async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
  token: string,
) {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        },
      },
    }),
  });
  return (await res.json()) as any;
}
async function until<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 20_000,
) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function warehouse(url: string, orderId: string, paymentId: string) {
  const body = JSON.stringify({
    eventId: `evt_${crypto.randomUUID()}`,
    type: "return.received",
    orgId: ORG.northstar,
    orderId,
    paymentId,
    reference: "SYNTHETIC-RMA",
  });
  const sig = await signWarehouseBody(
    WAREHOUSE_SECRET,
    body,
    Math.floor(Date.now() / 1000),
  );
  return (
    await fetch(`${url}/api/warehouse/events`, {
      method: "POST",
      headers: { "x-warehouse-signature": sig },
      body,
    })
  ).status;
}
const refunded = async (paymentId: string) =>
  (await payments.inspect(ORG.northstar, paymentId)).refundedMinor;
const executor = () =>
  new TaskAuthority({
    baseUrl: authorityUrl,
    getAccessToken: () => w.tok.executor(),
  });

test("the customer app is SIGKILLed while the client is gone and waiting on a human; a new process finishes with one refund", async () => {
  const paymentId = await payments.createPayment(ORG.northstar, 30000, "USD");
  const app1 = await startApp();
  const created = await rpc(
    app1.url,
    "tools/call",
    {
      name: "request_refund",
      arguments: {
        orderId: "R1",
        paymentId,
        amountMinor: 15000,
        currency: "USD",
        reason: "Returned item",
        exceptionNote: "Damaged on arrival, RMA verified.",
      },
    },
    await mcpToken(PEOPLE.alice),
  );
  const taskId = created.result.taskId as string;
  assert.equal(created.result.resultType, "task");
  assert.equal(await warehouse(app1.url, "R1", paymentId), 202);
  const task = (await until(
    async () => repo.get(taskId),
    (t) =>
      t?.stage === "awaiting_approval" &&
      /reviewer/i.test(t.statusMessage ?? ""),
  ))!;
  assert.match(task.statusMessage!, /reviewer/i);

  // The MCP client is gone (it never polls) and the app process dies hard.
  app1.child.kill("SIGKILL");
  await new Promise((r) => app1.child.once("exit", r));

  // While the app is down, the manager approves directly at the authority service.
  const op = await new TaskAuthority({
    baseUrl: authorityUrl,
    getAccessToken: () => w.tok.api(),
  }).operations.get(task.operationId!);
  assert.equal(op.approvalStatus, "pending");
  assert.equal((await w.approve(op.approvalId!, op.digest)).status, 200);
  assert.equal(await refunded(paymentId), 0);

  // A brand-new process, a brand-new credential: the task continues and the result is readable.
  const app2 = await startApp();
  const done = await until(
    async () =>
      (
        await rpc(
          app2.url,
          "tasks/get",
          { taskId },
          await mcpToken(PEOPLE.alice),
        )
      ).result,
    (r) => r?.status !== "working",
  );
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(done.resultType, "complete");
  assert.equal(done.result.structuredContent.outcome, "refunded");
  assert.equal(await refunded(paymentId), 15000);
  assert.equal(
    Number(
      (
        await repo.pool.query(
          "select count(*) n from refund_desk.sim_refunds where payment_id=$1",
          [paymentId],
        )
      ).rows[0].n,
    ),
    1,
  );
});

test("a worker that dies right after being granted a claim: the next process reconciles by key and refunds once", async () => {
  const paymentId = await payments.createPayment(ORG.northstar, 30000, "USD");
  const app1 = await startApp();
  const created = await rpc(
    app1.url,
    "tools/call",
    {
      name: "request_refund",
      arguments: {
        orderId: "R2",
        paymentId,
        amountMinor: 5000,
        currency: "USD",
        reason: "Returned item",
      },
    },
    await mcpToken(PEOPLE.alice),
  );
  const taskId = created.result.taskId as string;
  // Stop the app from acting, then emulate "claimed, then crashed before calling the provider".
  app1.child.kill("SIGKILL");
  await new Promise((r) => app1.child.once("exit", r));
  const task = (await repo.get(taskId))!;
  const claim = await executor().operations.authorizeAndClaim({
    operationId: task.operationId!,
    operationDigest: task.operationDigest!,
    executionKey: task.operationKey,
    businessStateVersion: `30000:0:USD`,
  });
  assert.equal(claim.decision, "authorized");
  assert.equal(await refunded(paymentId), 0);
  w.clock.advance(61_000); // the claim lease lapses without any outcome report

  const app2 = await startApp();
  assert.equal(await warehouse(app2.url, "R2", paymentId), 202);
  const done = await until(
    async () =>
      (
        await rpc(
          app2.url,
          "tasks/get",
          { taskId },
          await mcpToken(PEOPLE.alice),
        )
      ).result,
    (r) => r?.status !== "working",
  );
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(await refunded(paymentId), 5000);
  const claims = (
    await w.store.pool.query(
      "select seq, status from authority.claims where operation_id=$1 order by seq",
      [task.operationId],
    )
  ).rows;
  assert.deepEqual(
    claims.map((c) => [c.seq, c.status]),
    [
      [1, "released"],
      [2, "succeeded"],
    ],
  );
});
