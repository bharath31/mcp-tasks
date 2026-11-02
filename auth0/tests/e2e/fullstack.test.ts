// FULL-STACK end to end over real processes: the customer app and Task Authority run as separate
// Node processes with their own Postgres databases; tokens come from a LOCAL OIDC provider over
// HTTPS (not Auth0); FGA is a real OpenFGA server if OPENFGA_BIN is set, else an OpenFGA-API fake.
// The MCP client is the OFFICIAL @modelcontextprotocol/ext-tasks requester (withTasks).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, calculateJwkThumbprint } from "jose";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import {
  createApplicationInputHandler,
  resultFromTaskOutcome,
  withTasks,
  type TaskEnabledSession,
} from "@modelcontextprotocol/ext-tasks/client";
import pg from "pg";
import { CLIENTS, ORG, PEOPLE } from "@task-authority/test-fixtures";
import { fetchPort } from "../helpers/mcp-port.js";
import {
  MCP_CLIENT,
  OPERATOR_TOKEN,
  startStack,
  type Stack,
} from "../helpers/stack.js";
import { createTestDb } from "../helpers/pg.js";
import { MFA_CODE } from "../helpers/oidc-server.js";

let s: Stack;
let appPool: pg.Pool;
let servicePool: pg.Pool;
const NOTE = "Damaged on arrival; RMA verified by the warehouse.";

before(async () => {
  s = await startStack();
  appPool = new pg.Pool({ connectionString: s.appDb.url, max: 3 });
  servicePool = new pg.Pool({ connectionString: s.serviceDb.url, max: 3 });
});
after(async () => {
  await appPool.end();
  await servicePool.end();
  await s.close();
});

/** An official-requester session for one user. The token is fetched lazily, like a real client refreshing. */
function session(
  userKey: string,
  o: {
    url?: string;
    client?: string;
    answers?: (message: string) => string | null;
  } = {},
) {
  let token: string | undefined;
  const port = fetchPort({
    url: o.url ?? s.appOrigin,
    endpointId: o.url ?? "refund-desk-fullstack",
    token: async () => (token ??= await s.login(userKey, { client: o.client })),
  });
  const elicited: string[] = [];
  const sess = withTasks(port, {
    onInputRequest: createApplicationInputHandler({
      elicitation: async (req) => {
        elicited.push(String((req.params as { message?: string }).message));
        const note = o.answers?.(
          String((req.params as { message?: string }).message),
        );
        return note
          ? { action: "accept", content: { note } }
          : { action: "decline" };
      },
      sampling: async () => {
        throw new Error("this server never samples");
      },
      roots: async () => ({ roots: [] }),
    }),
  });
  return { sess, port, elicited };
}

const operator = async (path: string) =>
  (await (
    await fetch(`${s.appOrigin}${path}`, {
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    })
  ).json()) as any;
const payment = async (c: TaskEnabledSession, cents = 30000) => {
  const exec = await c.callTool("create_test_payment", {
    amountMinor: cents,
    currency: "USD",
    idempotencyKey: randomUUID(),
  });
  const result = resultFromTaskOutcome(
    (await exec.settle()).outcome,
  ) as unknown as {
    structuredContent: { paymentId: string };
  };
  return result.structuredContent.paymentId;
};
const refundCount = async (paymentId: string) =>
  Number(
    (
      await appPool.query(
        "select count(*) n from refund_desk.sim_refunds where payment_id=$1",
        [paymentId],
      )
    ).rows[0].n,
  );

/** Wait until the app has asked the service for a human decision, and return what the reviewer would see. */
async function pendingApproval(taskId: string) {
  const op = await s.until(
    async () => {
      const t = (await operator(`/operator/task?taskId=${taskId}`)).task;
      if (!t?.operationId) return null;
      const o = await s.authorityGet(`/v1/operations/${t.operationId}`);
      return o.json.approvalStatus === "pending"
        ? { ...o.json, task: t }
        : null;
    },
    (v) => v !== null,
  );
  assert.ok(op, "an approval request should be pending");
  return op as {
    id: string;
    digest: string;
    approvalId: string;
    correlationId: string;
    task: any;
  };
}

/** Set SCREENSHOT_DIR to save the approval page at each step (for design review). */
const SHOT = async (page: any, n: string) => {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${dir}/${n}.png`, fullPage: true });
};

describe("official requester, real processes (FR-005, FR-031..034, FR-040, FR-044)", () => {
  test("exception flow: create task, disconnect, signed event, manager decision at the service with fresh MFA, reconnect with a new credential and read the result", async () => {
    const a = session("alice");
    const paymentId = await payment(a.sess);
    const exec = await a.sess.callTool("request_refund", {
      orderId: "FS-742",
      paymentId,
      amountMinor: 15000,
      currency: "USD",
      reason: "Customer returned the item",
      exceptionNote: NOTE,
    });
    assert.equal(exec.kind, "task", "the server directed task creation");
    const ref = exec.kind === "task" ? exec.serializeReference() : null!;
    assert.equal(ref.generation, "v2");
    await exec.detach(); // the client goes away without cancelling

    const ev = await s.warehouse(s.appOrigin, "FS-742", paymentId);
    assert.equal(ev.status, 202);
    const op = await pendingApproval(ref.taskId);
    assert.equal(
      op.task.status,
      "working",
      "waiting on a human is not input_required",
    );
    assert.equal(await refundCount(paymentId), 0);

    // Wrong people first: all refused by the service itself.
    assert.equal(
      (await s.decide("mallory", op.approvalId, op.digest)).json.code,
      "not_authorized",
    );
    assert.equal(
      (await s.decide("eve", op.approvalId, op.digest)).json.code,
      "approver_ineligible",
    );
    assert.equal(
      (await s.decide("alice", op.approvalId, op.digest)).json.code,
      "approver_ineligible",
    );
    assert.equal(await refundCount(paymentId), 0);
    // The reviewer's step-up must be bound to this exact operation.
    const unbound = await s.login("morgan", {
      client: "reviewer_spa",
      audience: "https://task-authority.local/api",
    });
    const refused = await fetch(
      `${s.serviceUrl}/v1/approval-requests/${op.approvalId}/decisions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${unbound}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          decision: "approve",
          operationDigest: op.digest,
        }),
      },
    );
    assert.equal(
      ((await refused.json()) as { details: { reason: string } }).details
        .reason,
      "mfa_required",
    );

    const ok = await s.decide("morgan", op.approvalId, op.digest);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.status, "approved");

    // Reconnect: a different session object, a freshly issued credential, resumed from the saved reference.
    const b = session("alice");
    const resumed = await b.sess.resumeTask(ref);
    const settled = await resumed.settle();
    assert.equal(settled.outcome.status, "completed");
    const result = resultFromTaskOutcome(settled.outcome) as unknown as {
      isError?: boolean;
      structuredContent: {
        outcome: string;
        refundId: string;
        authority: { correlationId: string };
      };
    };
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.outcome, "refunded");
    assert.equal(await refundCount(paymentId), 1);
    assert.deepEqual(
      a.port.requests.every((r) => r.status === 200),
      true,
    );

    // Evidence: one correlation id across both layers, claims and approvals live only in the service DB.
    const audit = await s.authorityGet(
      `/v1/audit?correlationId=${result.structuredContent.authority.correlationId}`,
    );
    const types = audit.json.events.map((e: { type: string }) => e.type);
    for (const t of [
      "delegation.created",
      "operation.registered",
      "approval.requested",
      "approval.approved",
      "authorization.allowed",
      "claim.created",
      "outcome.reported",
    ])
      assert.ok(types.includes(t), t);
    assert.ok(
      audit.json.events.some(
        (e: { type: string; reasonCode: string }) =>
          e.type === "authorization.denied" &&
          e.reasonCode === "approver_org_mismatch",
      ),
    );
    const claims = await servicePool.query(
      "select status, count(*) over () n from authority.claims where operation_id=$1",
      [op.id],
    );
    assert.deepEqual(
      claims.rows.map((r) => [r.status, Number(r.n)]),
      [["succeeded", 1]],
    );
    const appTables = (
      await appPool.query(
        "select table_name from information_schema.tables where table_schema in ('refund_desk','authority')",
      )
    ).rows.map((r) => r.table_name);
    assert.ok(
      !appTables.some((t) => /delegation|approval|claim/.test(t)),
      "the customer database holds no authorization tables",
    );
  });

  test("input_required through the official requester: the elicitation is answered by the client's own handler and tasks/update is accepted", async () => {
    const a = session("alice", { answers: () => NOTE });
    const paymentId = await payment(a.sess);
    const exec = await a.sess.callTool("request_refund", {
      orderId: "FS-INPUT",
      paymentId,
      amountMinor: 15000,
      currency: "USD",
      reason: "Customer returned the item",
    });
    assert.equal(exec.kind, "task");
    const abort = new AbortController();
    const driving = exec
      .settle({ signal: abort.signal })
      .catch(() => undefined);
    const ref = exec.kind === "task" ? exec.serializeReference() : null!;
    const op = await s.until(
      async () => (await operator(`/operator/task?taskId=${ref.taskId}`)).task,
      (t) => Boolean(t?.operationId),
    );
    assert.ok(
      op.operationId,
      "authority was registered after the client answered",
    );
    assert.equal(a.elicited.length >= 1, true);
    assert.match(a.elicited[0]!, /exception note/i);
    abort.abort();
    await driving;
    await exec.detach().catch(() => undefined);
    const row = await servicePool.query(
      "select arguments->>'exceptionNote' note from authority.operations where id=$1",
      [op.operationId],
    );
    assert.equal(
      row.rows[0].note,
      NOTE,
      "the answer is part of the exact operation the reviewer will see",
    );
    await operator("/operator/worker/run");
  });

  test("a client that declines the input cancels the task and no authority is ever created", async () => {
    const a = session("alice", { answers: () => null });
    const paymentId = await payment(a.sess);
    const before = Number(
      (await servicePool.query("select count(*) n from authority.delegations"))
        .rows[0].n,
    );
    const exec = await a.sess.callTool("request_refund", {
      orderId: "FS-DECLINE",
      paymentId,
      amountMinor: 15000,
      currency: "USD",
      reason: "Customer returned the item",
    });
    const settled = await exec.settle();
    assert.equal(settled.outcome.status, "cancelled");
    assert.equal(
      Number(
        (
          await servicePool.query(
            "select count(*) n from authority.delegations",
          )
        ).rows[0].n,
      ),
      before,
    );
  });

  test("the automatic path ($50) completes through the official requester with no human", async () => {
    const a = session("alice");
    const paymentId = await payment(a.sess);
    const exec = await a.sess.callTool("request_refund", {
      orderId: "FS-50",
      paymentId,
      amountMinor: 5000,
      currency: "USD",
      reason: "Returned unopened",
    });
    assert.equal(exec.kind, "task");
    const driving = exec.settle();
    assert.equal(
      (await s.warehouse(s.appOrigin, "FS-50", paymentId)).status,
      202,
    );
    const settled = await driving;
    assert.equal(settled.outcome.status, "completed");
    assert.equal(await refundCount(paymentId), 1);
  });

  test("cancelling through the requester before dispatch withdraws authority; nothing is refunded", async () => {
    const a = session("alice");
    const paymentId = await payment(a.sess);
    const exec = await a.sess.callTool("request_refund", {
      orderId: "FS-CXL",
      paymentId,
      amountMinor: 5000,
      currency: "USD",
      reason: "Returned unopened",
    });
    const ref = exec.kind === "task" ? exec.serializeReference() : null!;
    await exec.cancel();
    const t = (await s.until(
      async () => (await operator(`/operator/task?taskId=${ref.taskId}`)).task,
      (x) => x?.status === "cancelled",
    )) as any;
    assert.equal(t.status, "cancelled");
    const op = await s.authorityGet(`/v1/operations/${t.operationId}`);
    assert.equal(op.json.status, "failed");
    assert.equal(op.json.lifecycleStatus, "cancelled");
    await s.warehouse(s.appOrigin, "FS-CXL", paymentId);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(await refundCount(paymentId), 0);
  });

  test("access control over the wire: other users, other organizations, wrong audience and machine tokens cannot read or act", async () => {
    const a = session("alice");
    const paymentId = await payment(a.sess);
    const exec = await a.sess.callTool("request_refund", {
      orderId: "FS-ACL",
      paymentId,
      amountMinor: 5000,
      currency: "USD",
      reason: "Returned unopened",
    });
    const ref = exec.kind === "task" ? exec.serializeReference() : null!;
    await exec.detach();
    for (const who of ["morgan", "mallory"]) {
      const other = session(who);
      const c = other.sess.task(ref.taskId);
      await assert.rejects(c.snapshot(), /not found/i, who);
    }
    // A token minted for the authority audience is not a valid MCP credential, and neither is a machine token.
    const wrongAud = await s.login("alice", {
      audience: "https://task-authority.local/api",
    });
    const bad = await fetch(`${s.appOrigin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${wrongAud}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      }),
    });
    assert.equal(bad.status, 401);
    assert.match(
      bad.headers.get("www-authenticate") ?? "",
      /resource_metadata=/,
    );
    const machine = await s.m2mToken("client_refund_desk_api");
    assert.equal(
      (
        await fetch(`${s.appOrigin}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${machine}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              },
            },
          }),
        })
      ).status,
      401,
    );
  });
});

describe("the authorization service restarts independently (FR-021)", () => {
  test("SIGKILL the service while the approval is pending: the app keeps the task working, the approval is durable, and the flow completes after restart", async () => {
    const a = session("alice");
    const paymentId = await payment(a.sess);
    const exec = await a.sess.callTool("request_refund", {
      orderId: "FS-RESTART-1",
      paymentId,
      amountMinor: 15000,
      currency: "USD",
      reason: "Customer returned the item",
      exceptionNote: NOTE,
    });
    const ref = exec.kind === "task" ? exec.serializeReference() : null!;
    await exec.detach();
    await s.warehouse(s.appOrigin, "FS-RESTART-1", paymentId);
    const op = await pendingApproval(ref.taskId);

    await s.service.kill();
    // While it is down: protected reads fail closed, the task is still honest, nothing is dispatched.
    await assert.rejects(
      fetch(`${s.serviceUrl}/healthz`, { signal: AbortSignal.timeout(1500) }),
    );
    const view = await session("alice").sess.task(ref.taskId).snapshot();
    assert.equal(view.status, "working");
    assert.equal(await refundCount(paymentId), 0);
    await s.restartService();

    const durable = await s.authorityGet(`/v1/operations/${op.id}`);
    assert.equal(
      durable.json.approvalStatus,
      "pending",
      "the approval request survived the process death",
    );
    assert.equal(
      (await s.decide("morgan", op.approvalId, op.digest)).status,
      200,
    );
    const settled = await (
      await session("alice").sess.resumeTask(ref)
    ).settle();
    assert.equal(settled.outcome.status, "completed");
    assert.equal(await refundCount(paymentId), 1);
  });

  test("SIGKILL the service after the decision and before the claim: the approval and its single-use token persist, so the same decision cannot be replayed", async () => {
    const a = session("alice");
    const paymentId = await payment(a.sess);
    const exec = await a.sess.callTool("request_refund", {
      orderId: "FS-RESTART-2",
      paymentId,
      amountMinor: 15000,
      currency: "USD",
      reason: "Customer returned the item",
      exceptionNote: NOTE,
    });
    const ref = exec.kind === "task" ? exec.serializeReference() : null!;
    await exec.detach();
    await s.warehouse(s.appOrigin, "FS-RESTART-2", paymentId);
    const op = await pendingApproval(ref.taskId);

    const token = await s.login("morgan", {
      client: "reviewer_spa",
      audience: "https://task-authority.local/api",
      details: [
        {
          type: "task_authority_approval",
          approval_id: op.approvalId,
          operation_digest: op.digest,
        },
      ],
    });
    const post = (t: string) =>
      fetch(`${s.serviceUrl}/v1/approval-requests/${op.approvalId}/decisions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${t}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          decision: "approve",
          operationDigest: op.digest,
        }),
      });
    assert.equal((await post(token)).status, 200);
    await s.service.kill();
    await s.restartService();
    // The same single-use token is still known after the restart.
    const second = await (await post(token)).json();
    assert.ok(
      second.status === "approved" ||
        second.details?.reason === "token_replayed",
      JSON.stringify(second),
    );
    const settled = await (
      await session("alice").sess.resumeTask(ref)
    ).settle();
    assert.equal(settled.outcome.status, "completed");
    assert.equal(await refundCount(paymentId), 1);
    const claims = await servicePool.query(
      "select count(*) n from authority.claims where operation_id=$1",
      [op.id],
    );
    assert.equal(Number(claims.rows[0].n), 1);
  });
});

describe("CIBA approval channel end to end (FR-023, local provider)", () => {
  test("the app asks the service, the service starts CIBA with the exact operation bound, the reviewer approves on their 'device', and the refund completes; a denial ends the task", async () => {
    const cibaDb = await createTestDb("rd");
    const port = await s.freePort();
    const ciba = await s.startApp(port, {
      REFUND_DESK_DATABASE_URL: cibaDb.url,
    });
    const url = `http://127.0.0.1:${port}`;
    const cibaPool = new pg.Pool({ connectionString: cibaDb.url, max: 3 });
    try {
      const a = session("alice", { url });
      const create = async (orderId: string) => {
        const pay = await payment(a.sess);
        const exec = await a.sess.callTool("request_refund", {
          orderId,
          paymentId: pay,
          amountMinor: 15000,
          currency: "USD",
          reason: "Customer returned the item",
          exceptionNote: NOTE,
        });
        const ref = exec.kind === "task" ? exec.serializeReference() : null!;
        await exec.detach();
        assert.equal((await s.warehouse(url, orderId, pay)).status, 202);
        const approval = await s.until<{ id: string } | undefined>(
          async () =>
            (
              await servicePool.query(
                "select a.id from authority.approvals a join authority.operations o on o.id=a.operation_id where o.arguments->>'orderId'=$1 and a.status='pending' order by a.requested_at desc limit 1",
                [orderId],
              )
            ).rows[0],
          (value) => Boolean(value),
        );
        const escalated = await fetch(
          `${s.serviceUrl}/v1/approval-requests/${approval!.id}/escalate`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${await s.m2mToken(CLIENTS.api)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ reviewerSubject: PEOPLE.morgan }),
          },
        );
        assert.equal(escalated.status, 200, await escalated.text());
        return { ref, pay };
      };
      const pollDecision = async (reqId: string) => {
        const row = (
          await servicePool.query(
            "select id from authority.approvals where ciba_auth_req_id=$1",
            [reqId],
          )
        ).rows[0];
        const res = await fetch(
          `${s.serviceUrl}/v1/approval-requests/${row.id}/ciba/poll`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${await s.m2mToken(CLIENTS.api)}`,
              "content-type": "application/json",
            },
            body: "{}",
          },
        );
        assert.equal(res.status, 200, await res.text());
      };
      const waitRequest = async (n: number) =>
        s.until(
          async () =>
            [...s.oidc.cibaRequests.entries()].filter(
              ([, r]) => r.status === "pending",
            ),
          (l) => l.length >= n,
        );

      const one = await create("FS-CIBA-1");
      const [[reqId, req]] = (await waitRequest(1)) as unknown as [
        [string, { details: Array<Record<string, string>> }],
      ];
      const approval = (
        await servicePool.query(
          "select id, operation_digest, method from authority.approvals where ciba_auth_req_id=$1",
          [reqId],
        )
      ).rows[0];
      assert.equal(approval.method, "ciba_rar");
      assert.deepEqual(req.details, [
        {
          type: "task_authority_approval",
          approval_id: approval.id,
          operation_digest: approval.operation_digest,
        },
      ]);
      assert.equal(
        Number(
          (
            await cibaPool.query(
              "select count(*) n from refund_desk.sim_refunds",
            )
          ).rows[0].n,
        ),
        0,
      );
      s.oidc.cibaDecide(reqId, true);
      await pollDecision(reqId);
      const settled = await (
        await session("alice", { url }).sess.resumeTask(one.ref)
      ).settle();
      assert.equal(settled.outcome.status, "completed");
      assert.equal(
        Number(
          (
            await cibaPool.query(
              "select count(*) n from refund_desk.sim_refunds where payment_id=$1",
              [one.pay],
            )
          ).rows[0].n,
        ),
        1,
      );

      const two = await create("FS-CIBA-2");
      const [[reqId2]] = (await waitRequest(1)) as unknown as [
        [string, unknown],
      ];
      s.oidc.cibaDecide(reqId2, false);
      await pollDecision(reqId2);
      const denied = await (
        await session("alice", { url }).sess.resumeTask(two.ref)
      ).settle();
      const result = resultFromTaskOutcome(denied.outcome) as unknown as {
        isError: boolean;
        structuredContent: { outcome: string };
      };
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.outcome, "approval_rejected");
      assert.equal(
        Number(
          (
            await cibaPool.query(
              "select count(*) n from refund_desk.sim_refunds where payment_id=$1",
              [two.pay],
            )
          ).rows[0].n,
        ),
        0,
      );
    } finally {
      await cibaPool.end();
      await ciba.kill();
      await cibaDb.drop();
    }
  });
});

describe("real Southridge flow over real processes", () => {
  test("Sam (Southridge) and Mallory (Southridge manager) complete an exception; Northstar's Morgan cannot", async () => {
    const sam = session("sam", { client: "mcp_client_sr" });
    const paymentId = await (async () => {
      const id = `pi_sim_sr_${randomUUID().slice(0, 8)}`;
      await appPool.query(
        "insert into refund_desk.sim_payments (payment_id, org_id, amount_minor, currency) values ($1,$2,30000,'USD')",
        [id, ORG.southridge],
      );
      return id;
    })();
    const exec = await sam.sess.callTool("request_refund", {
      orderId: "FS-SR-1",
      paymentId,
      amountMinor: 15000,
      currency: "USD",
      reason: "Wrong size shipped",
      exceptionNote: NOTE,
    });
    const ref = exec.kind === "task" ? exec.serializeReference() : null!;
    await exec.detach();
    await s.warehouse(s.appOrigin, "FS-SR-1", paymentId, ORG.southridge);
    const op = await pendingApproval(ref.taskId);
    assert.equal(
      (
        await s.decide(
          "morgan",
          op.approvalId,
          op.digest,
          "approve",
          ORG.northstar,
        )
      ).json.code,
      "not_authorized",
    );
    assert.equal(
      (
        await s.decide(
          "morgan",
          op.approvalId,
          op.digest,
          "approve",
          ORG.southridge,
        )
      ).status === 200,
      false,
    );
    assert.equal(
      (await s.decide("mallory", op.approvalId, op.digest)).status,
      200,
    );
    const settled = await (
      await session("sam", { client: "mcp_client_sr" }).sess.resumeTask(ref)
    ).settle();
    assert.equal(settled.outcome.status, "completed");
    assert.equal(await refundCount(paymentId), 1);
    void MCP_CLIENT;
  });
});

// The reviewer page in a REAL browser: the real SPA and the real @auth0/auth0-spa-js SDK talk to the
// LOCAL OIDC provider (not Auth0). Skipped when no Chromium is installed.
const CHROMIUM = [
  process.env.CHROMIUM_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/opt/pw-browsers/chromium",
  ...[
    "chromium-1194/chrome-linux/chrome",
    "chromium_headless_shell-1194/chrome-linux/headless_shell",
  ].map((p) => `/opt/pw-browsers/${p}`),
].find((p) => p && existsSync(p) && statSync(p).isFile());

describe("reviewer page in a real browser (FR-030, local provider)", () => {
  test(
    "the reviewer sees the exact operation, steps up with a second factor bound to it, and the task completes; a rejection ends it",
    { skip: !CHROMIUM && "no Chromium available" },
    async () => {
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({
        executablePath: CHROMIUM,
        args: ["--no-sandbox"],
      });
      try {
        const ask = async (orderId: string) => {
          const a = session("alice");
          const paymentId = await payment(a.sess);
          const exec = await a.sess.callTool("request_refund", {
            orderId,
            paymentId,
            amountMinor: 15000,
            currency: "USD",
            reason: "Customer returned the item",
            exceptionNote: NOTE,
          });
          const ref = exec.kind === "task" ? exec.serializeReference() : null!;
          await exec.detach();
          await s.warehouse(s.appOrigin, orderId, paymentId);
          return { a, paymentId, ref, op: await pendingApproval(ref.taskId) };
        };
        const review = async (
          approvalId: string,
          decision: "approve" | "reject",
          user: string,
        ) => {
          const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
          const page = await ctx.newPage();
          page.on("request", (request) => {
            if (
              request.url().startsWith(s.serviceUrl) &&
              request.headers().dpop
            ) {
              void (async () => {
                const token = request.headers().authorization!.split(" ")[1]!;
                const proof = request.headers().dpop!;
                const claims = decodeJwt(proof);
                const header = decodeProtectedHeader(proof);
                console.log("DPoP fixture diagnostics", {
                  target: request.url(),
                  method: request.method(),
                  htu: claims.htu,
                  htm: claims.htm,
                  age: Math.floor(Date.now() / 1000) - Number(claims.iat),
                  keyMatches:
                    (decodeJwt(token).cnf as { jkt: string }).jkt ===
                    (await calculateJwkThumbprint(header.jwk!)),
                  athMatches:
                    claims.ath ===
                    createHash("sha256").update(token).digest("base64url"),
                  typ: header.typ,
                  alg: header.alg,
                });
              })();
            }
          });
          await page.goto(
            `${s.appOrigin}/review.html?approval=${approvalId}&org=${encodeURIComponent(ORG.northstar)}`,
          );
          await page.getByRole("button", { name: "Sign in" }).waitFor();
          await SHOT(page, `signin-${decision}`);
          await page.getByRole("button", { name: "Sign in" }).click();
          await page.selectOption("select[name=_user]", user);
          await page.fill("input[name=_mfa]", MFA_CODE);
          await page.getByRole("button", { name: "Continue" }).click();
          // The page shows the exact operation before any decision is possible.
          await page
            .getByText("amountMinor")
            .waitFor()
            .catch(async () => {
              throw new Error(
                `Reviewer UI failed after login: ${await page.locator("#status").innerText()}; page ${new URL(page.url()).pathname}`,
              );
            });
          await SHOT(page, `view-${decision}`);
          const shown = await page.locator("body").innerText();
          assert.match(shown, /15000/);
          assert.match(shown, /refund:create/);
          await page
            .getByRole("button", { name: "Claim item", exact: true })
            .click();
          await page
            .getByRole("button", {
              name: decision === "approve" ? "Approve" : "Reject",
              exact: true,
            })
            .click();
          if (decision === "approve") {
            await page.selectOption("select[name=_user]", user);
            await page.fill("input[name=_mfa]", MFA_CODE);
            await page.getByRole("button", { name: "Continue" }).click();
            await page
              .getByRole("button", { name: /^Confirm approve/ })
              .waitFor();
            await SHOT(page, "confirm");
            await page
              .getByRole("button", { name: /^Confirm approve/ })
              .click();
          }
          await page
            .locator("#status", { hasText: /Recorded|Refused/ })
            .waitFor();
          await SHOT(page, `done-${decision}`);
          const outcome = await page.locator("#status").innerText();
          await ctx.close();
          return outcome;
        };

        const yes = await ask("FS-BROWSER-1");
        assert.match(
          await review(yes.op.approvalId, "approve", "morgan"),
          /Recorded: approved/,
        );
        const settled = await (
          await session("alice").sess.resumeTask(yes.ref)
        ).settle();
        assert.equal(settled.outcome.status, "completed");
        assert.equal(await refundCount(yes.paymentId), 1);

        const no = await ask("FS-BROWSER-2");
        assert.match(
          await review(no.op.approvalId, "reject", "morgan"),
          /Recorded: rejected/,
        );
        const ended = await (
          await session("alice").sess.resumeTask(no.ref)
        ).settle();
        const endedResult = resultFromTaskOutcome(ended.outcome) as unknown as {
          isError: boolean;
          structuredContent: { outcome: string };
        };
        assert.equal(endedResult.isError, true);
        assert.equal(
          endedResult.structuredContent.outcome,
          "approval_rejected",
        );
        assert.equal(await refundCount(no.paymentId), 0);

        // An ineligible person cannot even see the operation: the service refuses the read.
        const third = await ask("FS-BROWSER-3");
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        await page.goto(
          `${s.appOrigin}/review.html?approval=${third.op.approvalId}&org=${encodeURIComponent(ORG.northstar)}`,
        );
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.selectOption("select[name=_user]", "eve");
        await page.fill("input[name=_mfa]", MFA_CODE);
        await page.getByRole("button", { name: "Continue" }).click();
        await page
          .locator("#status", { hasText: /not_found|not_authorized/ })
          .waitFor();
        await SHOT(page, "denied");
        assert.equal(
          await page.getByRole("button", { name: /Approve/ }).count(),
          0,
        );
        await ctx.close();
        assert.equal(await refundCount(third.paymentId), 0);
      } finally {
        await browser.close();
      }
    },
  );
});

describe("owner approval in a real browser (local provider)", () => {
  test(
    "with self_approval owner, the MCP client is asked via URL elicitation, the owner approves with a passkey, and the refund happens once",
    { skip: !CHROMIUM && "no Chromium available" },
    async () => {
      const current = await servicePool.query(
        "select resource_server, active_version from authority.policy_state where tenant_id='tnt_demo'",
      );
      const { resource_server: rs, active_version: active } = current.rows[0];
      const stored = await servicePool.query(
        "select document from authority.policy_versions where tenant_id='tnt_demo' and resource_server=$1 and version=$2",
        [rs, active],
      );
      const document = structuredClone(stored.rows[0].document);
      document.version = "owner-approval-fullstack";
      document.actions["refund:create"].self_approval = "owner";
      await servicePool.query(
        "insert into authority.policy_versions(tenant_id,resource_server,version,document,created_by,created_at) values('tnt_demo',$1,$2,$3,'fixture',now())",
        [rs, document.version, JSON.stringify(document)],
      );
      await servicePool.query(
        "update authority.policy_state set active_version=$2 where tenant_id='tnt_demo' and resource_server=$1",
        [rs, document.version],
      );
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({
        executablePath: CHROMIUM,
        args: ["--no-sandbox"],
      });
      try {
        const a = session("alice", {
          answers: (message) => (/passkey/i.test(message) ? "opened" : null),
        });
        const paymentId = await payment(a.sess);
        const exec = await a.sess.callTool("request_refund", {
          orderId: "FS-OWNER-1",
          paymentId,
          amountMinor: 15000,
          currency: "USD",
          reason: "Customer returned the item",
          exceptionNote: NOTE,
        });
        const ref = exec.kind === "task" ? exec.serializeReference() : null!;
        await exec.detach();
        await s.warehouse(s.appOrigin, "FS-OWNER-1", paymentId);
        const op = await pendingApproval(ref.taskId);
        assert.equal((op as { ownerApproval?: boolean }).ownerApproval, true);
        // The client keeps driving the task: it answers the URL elicitation and waits.
        const driving = (await a.sess.resumeTask(ref)).settle();

        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        // The owner's queue lists their agent's request next to anything they review.
        await page.goto(`${s.appOrigin}/review.html`);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.selectOption("select[name=_user]", "alice");
        await page.fill("input[name=_mfa]", MFA_CODE);
        await page.getByRole("button", { name: "Continue" }).click();
        const row = page.locator(`a[href*="${op.approvalId}"]`);
        await row.waitFor();
        assert.match(await row.innerText(), /Your agent/);
        await SHOT(page, "owner-queue");
        await row.click();
        await page.getByText("Your agent is asking for approval").waitFor();
        await SHOT(page, "owner-view");
        // No queue lease for the owner, and OTP is not enough to approve their own agent.
        assert.equal(
          await page.getByRole("button", { name: "Claim item" }).count(),
          0,
        );
        const approveWith = async (factor: string) => {
          await page
            .getByRole("button", { name: "Approve", exact: true })
            .click();
          await page.selectOption("select[name=_user]", "alice");
          await page.fill("input[name=_mfa]", MFA_CODE);
          await page.selectOption("select[name=_factor]", factor);
          await page.getByRole("button", { name: "Continue" }).click();
          await page.getByRole("button", { name: /^Confirm approve/ }).click();
          await page
            .locator("#status", { hasText: /Recorded|Refused/ })
            .waitFor();
          return page.locator("#status").innerText();
        };
        assert.match(await approveWith("otp"), /Refused/);
        assert.match(
          await approveWith("webauthn-platform"),
          /Recorded: approved/,
        );
        await SHOT(page, "owner-done");
        await ctx.close();

        const settled = await driving;
        assert.equal(settled.outcome.status, "completed");
        assert.equal(await refundCount(paymentId), 1);
        assert.ok(a.elicited.some((m) => /passkey/i.test(m)));
      } finally {
        await browser.close();
        await servicePool.query(
          "update authority.policy_state set active_version=$2 where tenant_id='tnt_demo' and resource_server=$1",
          [rs, active],
        );
      }
    },
  );
});

describe("deployment smoke script against the running stack", () => {
  test("demo/tools/verify-live.ts passes against the real processes (reachability, error contracts, origin policy, no secret leakage)", () => {
    const r = spawnSync(
      "node",
      ["--import", "tsx", "demo/tools/verify-live.ts"],
      {
        cwd: new URL("../../../", import.meta.url).pathname,
        env: {
          ...process.env,
          TASK_AUTHORITY_URL: s.serviceUrl,
          REFUND_DESK_URL: s.appOrigin,
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stdout, /^FAIL/m);
    assert.match(r.stdout, /PASS/);
  });
});
