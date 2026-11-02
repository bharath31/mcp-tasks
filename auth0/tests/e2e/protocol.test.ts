import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  CancelTaskResultV2Schema,
  CreateTaskResultV2Schema,
  GetTaskResultV2Schema,
  InputRequiredTaskV2Schema,
  UpdateTaskResultV2Schema,
  isCreateTaskResultV2,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import { MCP_AUDIENCE, createDesk, type Desk } from "../helpers/desk.js";
import { ORG, PEOPLE } from "../helpers/world.js";

let d: Desk;
before(async () => {
  d = await createDesk();
});
after(async () => d.close());

const taskOf = (r: Awaited<ReturnType<Desk["refund"]>>) =>
  r.body.result as { taskId: string; status: string };
const refundCount = async () =>
  Number(
    (await d.repo.pool.query("select count(*) n from refund_desk.sim_refunds"))
      .rows[0].n,
  );

describe("negotiation and versioning (spec 2026-07-28)", () => {
  test("server/discover is public, lists the version, advertises the tasks extension and no unsupported features", async () => {
    const r = await d.rpc("server/discover");
    assert.equal(r.status, 200);
    const res = r.body.result;
    assert.equal(res.resultType, "complete");
    assert.deepEqual(res.supportedVersions, ["2026-07-28"]);
    assert.deepEqual(res.capabilities.extensions, {
      "io.modelcontextprotocol/tasks": {},
    });
    assert.ok(res._meta["io.modelcontextprotocol/serverInfo"].name);
    assert.equal(
      res.capabilities.subscriptions,
      undefined,
      "subscriptions/listen is not advertised",
    );
  });
  test("unsupported version -> -32022 listing supported versions; missing version and legacy initialize are refused", async () => {
    const v = await d.rpc("server/discover", {}, { version: "1900-01-01" });
    assert.equal(v.status, 400);
    assert.equal(v.body.error.code, -32022);
    assert.deepEqual(v.body.error.data, {
      supported: ["2026-07-28"],
      requested: "1900-01-01",
    });
    const init = await d.rpc("initialize", {});
    assert.equal(init.status, 400);
    assert.equal(init.body.error.code, -32022);
    assert.match(init.body.error.message, /2026-07-28/);
    const mismatch = await d.rpc(
      "server/discover",
      {},
      { headers: { "mcp-protocol-version": "2025-11-25" } },
    );
    assert.equal(mismatch.status, 400);
  });
  test("protected-resource metadata (RFC 9728) and bearer challenges point clients at the authorization server", async () => {
    const meta = await (
      await d.app(
        new Request(
          "https://refund-desk.test/.well-known/oauth-protected-resource",
        ),
      )
    ).json();
    assert.equal(meta.resource, "https://refund-desk.test");
    assert.deepEqual(meta.authorization_servers, [
      "https://test-tenant.example/",
    ]);
    const none = await d.rpc("tools/list");
    assert.equal(none.status, 401);
    assert.match(
      none.headers.get("www-authenticate")!,
      /^Bearer resource_metadata="https:\/\/refund-desk.test\/.well-known\/oauth-protected-resource"/,
    );
    const bad = await d.rpc("tools/list", {}, { token: "a.b.c" });
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get("www-authenticate")!, /error="invalid_token"/);
  });
  test("tokens for the wrong audience, without an organization, or from an unregistered agent client are refused", async () => {
    const wrongAud = await d.w.idp.mint({
      sub: PEOPLE.alice,
      orgId: ORG.northstar,
      azp: "client_mcp_returns_agent",
      audience: "https://other.example",
      iat: Math.floor(Date.now() / 1000),
    });
    assert.equal(
      (await d.rpc("tools/list", {}, { token: wrongAud })).status,
      401,
    );
    const noOrg = await d.w.idp.mint({
      sub: PEOPLE.alice,
      azp: "client_mcp_returns_agent",
      audience: MCP_AUDIENCE,
      iat: Math.floor(Date.now() / 1000),
    });
    assert.equal((await d.rpc("tools/list", {}, { token: noOrg })).status, 403);
    const stranger = await d.mcpToken(PEOPLE.alice, ORG.northstar, {
      client: "client_unregistered",
    });
    assert.equal(
      (await d.rpc("tools/list", {}, { token: stranger })).status,
      403,
    );
  });
  test("tools/list is a complete result; unknown tools and bad arguments are invalid params", async () => {
    const t = await d.alice();
    const l = await d.rpc("tools/list", {}, { token: t });
    assert.deepEqual(
      l.body.result.tools.map((x: { name: string }) => x.name),
      ["request_refund", "create_test_payment", "get_payment"],
    );
    assert.equal(
      (await d.rpc("tools/call", { name: "nope", arguments: {} }, { token: t }))
        .body.error.code,
      -32602,
    );
    assert.equal(
      (
        await d.rpc(
          "tools/call",
          { name: "create_test_payment", arguments: { amountMinor: 5 } },
          { token: t },
        )
      ).body.error.code,
      -32602,
    );
  });
  test("retired and unadvertised methods are not found: tasks/list, tasks/result, subscriptions/listen", async () => {
    const t = await d.alice();
    for (const m of ["tasks/list", "tasks/result", "subscriptions/listen"])
      assert.equal(
        (await d.rpc(m, {}, { token: t })).body.error.code,
        -32601,
        m,
      );
  });
});

describe("task creation, polling and completion", () => {
  test("a client that did not declare the extension never receives a task: -32021, and nothing is created", async () => {
    const paymentId = await d.payment();
    const before = Number(
      (await d.repo.pool.query("select count(*) n from refund_desk.tasks"))
        .rows[0].n,
    );
    const r = await d.rpc(
      "tools/call",
      {
        name: "request_refund",
        arguments: {
          orderId: "9",
          paymentId,
          amountMinor: 5000,
          currency: "USD",
          reason: "returned",
        },
      },
      { token: await d.alice(), tasks: false },
    );
    assert.equal(r.body.error.code, -32021);
    assert.deepEqual(r.body.error.data.requiredCapabilities, {
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
    assert.equal(
      Number(
        (await d.repo.pool.query("select count(*) n from refund_desk.tasks"))
          .rows[0].n,
      ),
      before,
    );
  });

  test("automatic path ($50): CreateTaskResult, durable before return, working while waiting, then completed with one refund", async () => {
    const paymentId = await d.payment();
    const created = await d.refund({
      paymentId,
      amountMinor: 5000,
      orderId: "A50",
    });
    assert.ok(isCreateTaskResultV2(created.body.result));
    const parsed = CreateTaskResultV2Schema.parse(created.body.result);
    assert.equal(parsed.resultType, "task");
    assert.equal(parsed.status, "working");
    assert.match(parsed.taskId, /^[0-9a-f-]{36}$/);
    assert.ok(Number.isInteger(parsed.ttlMs) && parsed.pollIntervalMs! > 0);
    // Durable before the handle was returned: it is immediately readable.
    const first = GetTaskResultV2Schema.parse(await d.get(parsed.taskId));
    assert.equal(first.status, "working");
    assert.equal(first.resultType, "complete");
    assert.match(first.statusMessage!, /warehouse return/i);
    // Waiting on an external event is "working", never an empty input_required.
    await d.tick(2);
    assert.equal((await d.get(parsed.taskId)).status, "working");

    assert.equal((await d.warehouse("A50", paymentId)).body.matchedTask, true);
    for (let i = 0; i < 4; i++) await d.step(1000);
    const done = GetTaskResultV2Schema.parse(await d.get(parsed.taskId));
    assert.equal(done.status, "completed");
    if (done.status !== "completed") return;
    assert.equal(done.result.isError, false);
    const sc = (done.result as any).structuredContent;
    assert.equal(sc.outcome, "refunded");
    assert.equal(sc.authority.operationId.startsWith("op_"), true);
    assert.equal((await refundCount()) >= 1, true);
    const p = await d.payments.inspect(ORG.northstar, paymentId);
    assert.equal(p.refundedMinor, 5000);
  });

  test("tasks/get on a terminal task keeps returning the same result (reconnect, credential rotation)", async () => {
    const paymentId = await d.payment();
    const t = taskOf(
      await d.refund({ paymentId, amountMinor: 2500, orderId: "A25" }),
    );
    await d.warehouse("A25", paymentId);
    for (let i = 0; i < 4; i++) await d.step(1000);
    const a = await d.get(t.taskId);
    // A freshly issued credential (rotation) for the same user reads the same retained result.
    const b = await d.get(
      t.taskId,
      await d.mcpToken(PEOPLE.alice, ORG.northstar),
    );
    assert.equal(a.status, "completed");
    assert.deepEqual(b.result, a.result);
    assert.equal(b.lastUpdatedAt, a.lastUpdatedAt);
  });

  test("retrying the same request returns the same task; a changed currency conflicts; no second refund", async () => {
    const paymentId = await d.payment();
    const a = taskOf(
      await d.refund({ paymentId, amountMinor: 4000, orderId: "DUP" }),
    );
    const b = taskOf(
      await d.refund({ paymentId, amountMinor: 4000, orderId: "DUP" }),
    );
    assert.equal(b.taskId, a.taskId);
    const c = await d.refund({
      paymentId,
      amountMinor: 4000,
      orderId: "DUP",
      currency: "EUR",
    });
    assert.equal(c.body.result.isError, true);
    assert.equal(
      c.body.result.structuredContent.outcome,
      "operation_parameters_conflict",
    );
  });

  test("a refund the business rules reject never reaches Task Authority", async () => {
    const paymentId = await d.payment(10000);
    const ops = Number(
      (
        await d.w.store.pool.query(
          "select count(*) n from authority.operations",
        )
      ).rows[0].n,
    );
    const r = await d.refund({
      paymentId,
      amountMinor: 20000,
      orderId: "TOO-MUCH",
      note: "customer insisted",
    });
    assert.equal(r.body.result.isError, true);
    assert.equal(
      r.body.result.structuredContent.outcome,
      "refund_not_eligible",
    );
    assert.equal(
      Number(
        (
          await d.w.store.pool.query(
            "select count(*) n from authority.operations",
          )
        ).rows[0].n,
      ),
      ops,
    );
  });
});

describe("input_required and tasks/update (genuine client-answerable input only)", () => {
  test("an exception note is requested via inputRequests; unknown, forged and duplicate answers are ignored; one valid answer proceeds exactly once", async () => {
    const paymentId = await d.payment();
    const t = taskOf(
      await d.refund({ paymentId, amountMinor: 15000, orderId: "EXC" }),
    );
    assert.equal(t.status, "input_required");
    const view = InputRequiredTaskV2Schema.parse(await d.get(t.taskId));
    assert.deepEqual(Object.keys(view.inputRequests), ["exception_note"]);
    assert.equal(
      view.inputRequests.exception_note!.method,
      "elicitation/create",
    );
    assert.ok(
      Object.keys(view.inputRequests).length > 0,
      "input_required always carries real requests",
    );
    const tok = await d.alice();
    const ops = async () =>
      Number(
        (
          await d.w.store.pool.query(
            "select count(*) n from authority.delegations",
          )
        ).rows[0].n,
      );
    const delegations = await ops();

    // Wrong key and a forged approval flag are ignored.
    for (const forged of [
      { unknown_key: { action: "accept", content: { note: "hello there" } } },
      { approved: { action: "accept", content: { approved: true } } },
    ]) {
      const u = await d.rpc(
        "tasks/update",
        { taskId: t.taskId, inputResponses: forged },
        { token: tok },
      );
      UpdateTaskResultV2Schema.parse(u.body.result);
    }
    assert.equal((await d.get(t.taskId)).status, "input_required");
    assert.equal(await ops(), delegations);

    const answer = {
      exception_note: {
        action: "accept",
        content: { note: "Customer returned a damaged unit, RMA approved." },
      },
    };
    const [x, y] = await Promise.all([
      d.rpc(
        "tasks/update",
        { taskId: t.taskId, inputResponses: answer },
        { token: tok },
      ),
      d.rpc(
        "tasks/update",
        { taskId: t.taskId, inputResponses: answer },
        { token: tok },
      ),
    ]);
    assert.equal(x.body.result.resultType, "complete");
    assert.equal(y.body.result.resultType, "complete");
    const after = await d.get(t.taskId);
    assert.equal(after.status, "working", JSON.stringify(after));
    assert.equal(
      await ops(),
      delegations + 1,
      "duplicate updates authorize once",
    );
    // A late repeat of an already-answered key is ignored.
    await d.rpc(
      "tasks/update",
      { taskId: t.taskId, inputResponses: answer },
      { token: tok },
    );
    assert.equal(await ops(), delegations + 1);
    // The note is part of the exact operation the reviewer will see and the digest binds it.
    const task = (await d.repo.get(t.taskId))!;
    const op = await d.authority.operations.get(task.operationId!);
    assert.equal(op.approvalRequirement, "human");
    const row = await d.w.store.pool.query(
      "select arguments from authority.operations where id=$1",
      [task.operationId],
    );
    assert.match(row.rows[0].arguments.exceptionNote, /damaged unit/);
  });
  test("declining the input cancels the task without creating any authority", async () => {
    const paymentId = await d.payment();
    const t = taskOf(
      await d.refund({ paymentId, amountMinor: 16000, orderId: "DECLINE" }),
    );
    const before = Number(
      (
        await d.w.store.pool.query(
          "select count(*) n from authority.delegations",
        )
      ).rows[0].n,
    );
    await d.rpc(
      "tasks/update",
      {
        taskId: t.taskId,
        inputResponses: { exception_note: { action: "decline" } },
      },
      { token: await d.alice() },
    );
    assert.equal((await d.get(t.taskId)).status, "cancelled");
    assert.equal(
      Number(
        (
          await d.w.store.pool.query(
            "select count(*) n from authority.delegations",
          )
        ).rows[0].n,
      ),
      before,
    );
  });
});

describe("authorization of task access (FR-017)", () => {
  test("a task id is not a credential: other users, other organizations and unknown ids are indistinguishable", async () => {
    const paymentId = await d.payment();
    const t = taskOf(
      await d.refund({ paymentId, amountMinor: 5000, orderId: "ACL" }),
    );
    const morgan = await d.mcpToken(PEOPLE.morgan, ORG.northstar);
    const mallory = await d.mcpToken(PEOPLE.mallory, ORG.southridge);
    const unknown = "11111111-1111-4111-8111-111111111111";
    const seen = new Set<string>();
    for (const [method, tok] of [
      ["tasks/get", morgan],
      ["tasks/get", mallory],
      ["tasks/cancel", morgan],
      ["tasks/cancel", mallory],
      ["tasks/update", mallory],
    ] as const) {
      const r = await d.rpc(
        method,
        { taskId: t.taskId, inputResponses: {} },
        { token: tok },
      );
      seen.add(JSON.stringify(r.body.error));
    }
    const ghost = await d.rpc(
      "tasks/get",
      { taskId: unknown },
      { token: morgan },
    );
    seen.add(JSON.stringify(ghost.body.error));
    assert.equal(seen.size, 1, [...seen].join("\n"));
    assert.equal(
      (await d.get(t.taskId)).status,
      "working",
      "other users could not cancel it",
    );
    assert.equal(
      (await d.rpc("tasks/get", { taskId: "not-a-uuid" }, { token: morgan }))
        .body.error.code,
      -32602,
    );
  });
  test("Mcp-Name must match params.taskId", async () => {
    const r = await d.rpc(
      "tasks/get",
      { taskId: "11111111-1111-4111-8111-111111111111" },
      {
        token: await d.alice(),
        headers: { "mcp-name": "22222222-2222-4222-8222-222222222222" },
      },
    );
    assert.equal(r.status, 400);
  });
  test("a rotated credential reads its own task but cannot renew the old delegation", async () => {
    const paymentId = await d.payment();
    const t = taskOf(
      await d.refund({ paymentId, amountMinor: 6000, orderId: "ROT" }),
    );
    const task = (await d.repo.get(t.taskId))!;
    const before = await d.authority.delegations.get(task.delegationId!);
    d.w.clock.advance(3 * 3600_000);
    const read = await d.get(
      t.taskId,
      await d.mcpToken(PEOPLE.alice, ORG.northstar),
    );
    assert.equal(read.status, "working");
    const after = await d.authority.delegations.get(task.delegationId!);
    assert.equal(after.expiresAt, before.expiresAt);
    assert.equal(after.id, before.id);
  });
  test("results stay retained for 7 days independent of authority, then are no longer discoverable", async () => {
    const paymentId = await d.payment();
    const t = taskOf(
      await d.refund({ paymentId, amountMinor: 1000, orderId: "RET" }),
    );
    await d.warehouse("RET", paymentId);
    for (let i = 0; i < 4; i++) await d.step(1000);
    d.w.clock.advance(3 * 86400_000); // delegation (48h) long gone, result still readable
    assert.equal((await d.get(t.taskId)).status, "completed");
    d.w.clock.advance(5 * 86400_000);
    assert.equal(
      (
        await d.rpc(
          "tasks/get",
          { taskId: t.taskId },
          { token: await d.alice() },
        )
      ).body.error.message,
      "Task not found",
    );
    assert.ok(
      await d.repo.get(t.taskId),
      "the private record is kept for reconciliation",
    );
  });
  test("tasks/cancel before dispatch withdraws authority at the service and acknowledges with an empty complete result", async () => {
    const paymentId = await d.payment();
    const t = taskOf(
      await d.refund({ paymentId, amountMinor: 7000, orderId: "CXL" }),
    );
    const task = (await d.repo.get(t.taskId))!;
    const r = await d.rpc(
      "tasks/cancel",
      { taskId: t.taskId },
      { token: await d.alice() },
    );
    CancelTaskResultV2Schema.parse(r.body.result);
    assert.equal((await d.get(t.taskId)).status, "cancelled");
    assert.equal(
      (await d.authority.operations.get(task.operationId!)).status,
      "cancelled",
    );
    assert.equal(
      (await d.authority.delegations.get(task.delegationId!)).status,
      "revoked",
    );
    await d.warehouse("CXL", paymentId);
    await d.step(1000);
    assert.equal(
      (await d.payments.inspect(ORG.northstar, paymentId)).refundedMinor,
      0,
    );
    // Cancelling again is a harmless acknowledgement; the task is never revived by retrying the request.
    assert.equal(
      (
        await d.rpc(
          "tasks/cancel",
          { taskId: t.taskId },
          { token: await d.alice() },
        )
      ).body.result.resultType,
      "complete",
    );
    assert.equal(
      taskOf(await d.refund({ paymentId, amountMinor: 7000, orderId: "CXL" }))
        .status,
      "cancelled",
    );
  });
});
