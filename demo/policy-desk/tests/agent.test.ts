import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseModelOutput } from "../src/agent.js";
import { startWorld, type World } from "./helpers/world.js";

let w: World;
let alice: string;
let sandboxId: string;
before(async () => {
  w = await startWorld();
  alice = await w.login("alice");
  const r = await w.call("POST", "/sandbox/reset", alice, {});
  sandboxId = r.json.sandboxId;
});
after(async () => w.close());

async function m2m(id: string, secret: string) {
  const res = await fetch(`${w.oidc.issuer}oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: secret,
      audience: w.env.TASK_AUTHORITY_AUDIENCE!,
    }),
  });
  return ((await res.json()) as any).access_token as string;
}

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/tasks": {} },
  },
};
/** A plain MCP client call, exactly what any MCP Tasks requester sends. */
async function mcp(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  meta: Record<string, unknown> = META,
) {
  const r = await w.raw("/mcp", {
    method: "POST",
    token,
    headers: { "x-policy-desk-sandbox": sandboxId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: meta },
    }),
  });
  return { status: r.status, json: (await r.json()) as any };
}

const order = async (customer: string) =>
  (await w.call("GET", "/sandbox/orders", alice)).json.orders.find(
    (o: any) => o.customer === customer,
  );

describe("MCP channel: the refund app's tools over MCP Tasks 2026-07-28", () => {
  let agent: string;
  before(async () => {
    agent = await m2m("agent", "agt-s");
  });

  it("discovers, lists tools, and refuses a refund to a client without the tasks extension", async () => {
    const d = await mcp(agent, "server/discover");
    assert.ok(
      d.json.result.capabilities.extensions["io.modelcontextprotocol/tasks"],
    );
    const t = await mcp(agent, "tools/list");
    assert.deepEqual(
      t.json.result.tools.map((x: any) => x.name),
      ["list_orders", "get_order", "request_refund"],
    );
    const noCap = await mcp(
      agent,
      "tools/call",
      {
        name: "request_refund",
        arguments: { orderId: "x", amountMinor: 100, reason: "r" },
      },
      { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    );
    assert.equal(noCap.json.error.code, -32021);
  });

  it("an M2M client that is not the registered agent cannot use the tools", async () => {
    const other = await m2m("executor", "exe-s");
    const r = await mcp(other, "tools/list");
    assert.equal(r.status, 403);
    const none = await w.raw("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: META },
      }),
    });
    assert.equal(none.status, 401);
    assert.equal(
      none.headers.get("www-authenticate"),
      'Bearer resource_metadata="https://policy-desk.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("publishes RFC 9728 metadata so MCP hosts can sign in on their own", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const r = await w.call("GET", path);
      assert.equal(r.status, 200);
      assert.equal(r.json.resource, "https://policy-desk.test/mcp");
      assert.equal(r.json.authorization_servers.length, 1);
      assert.match(r.json.authorization_servers[0], /^https:\/\//);
    }
  });

  it("a small refund completes; a larger one waits for a person and runs once after approval", async () => {
    const dana = await order("Dana Whitfield");
    const small = await mcp(agent, "tools/call", {
      name: "request_refund",
      arguments: { orderId: dana.orderId, amountMinor: 4000, reason: "Torn" },
    });
    assert.equal(small.json.result.resultType, "task", JSON.stringify(small));
    assert.equal(small.json.result.status, "completed");
    const done = await mcp(agent, "tasks/get", {
      taskId: small.json.result.taskId,
    });
    assert.equal(done.json.result.result.structuredContent.outcome, "refunded");

    const mei = await order("Mei Tanaka");
    const big = await mcp(agent, "tools/call", {
      name: "request_refund",
      arguments: { orderId: mei.orderId, amountMinor: 13900, reason: "Dead" },
    });
    const taskId = big.json.result.taskId;
    assert.equal(big.json.result.status, "working");
    assert.match(big.json.result.statusMessage, /\/review\?approval=/);
    const meta = big.json.result._meta["task-authority/decision"];
    assert.equal(meta.decision, "approval_required");

    // Polling never approves: still working.
    const still = await mcp(agent, "tasks/get", { taskId });
    assert.equal(still.json.result.status, "working");

    const op = (await w.call("GET", `/v1/refunds/${taskId}`, alice)).json
      .operation;
    // The $139 refund from the live report: the second factor from sign-in is not enough.
    const signInMfa = await w.reviewer("alice");
    const reused = await signInMfa.post(
      `/v1/approval-requests/${meta.approvalId}/decisions`,
      { decision: "approve", operationDigest: op.digest },
    );
    assert.equal(reused.status, 403, JSON.stringify(reused.json));
    assert.equal(
      (await mcp(agent, "tasks/get", { taskId })).json.result.status,
      "working",
    );
    const d = await w.decideWithStepUp("alice", meta.approvalId, op.digest);
    assert.equal(d.status, 200, JSON.stringify(d.json));

    const ran = await mcp(agent, "tasks/get", { taskId });
    assert.equal(ran.json.result.status, "completed", JSON.stringify(ran));
    const again = await mcp(agent, "tasks/get", { taskId });
    assert.equal(again.json.result.status, "completed");
    assert.equal((await order("Mei Tanaka")).refundedMinor, 13900);
  });

  it("tasks/cancel is acknowledged; an unclaimed refund is withdrawn and can no longer run", async () => {
    const kwame = await order("Kwame Mensah");
    const big = await mcp(agent, "tools/call", {
      name: "request_refund",
      arguments: { orderId: kwame.orderId, amountMinor: 20000, reason: "Hiss" },
    });
    const taskId = big.json.result.taskId;
    assert.equal(big.json.result.status, "working", JSON.stringify(big));
    const approvalId =
      big.json.result._meta["task-authority/decision"].approvalId;
    const ack = await mcp(agent, "tasks/cancel", { taskId });
    assert.equal(ack.status, 200);
    assert.deepEqual(ack.json.result, { resultType: "complete" });
    const after = await mcp(agent, "tasks/get", { taskId });
    assert.equal(after.json.result.status, "cancelled");
    // A reviewer arriving late cannot bring it back.
    const op = (await w.call("GET", `/v1/refunds/${taskId}`, alice)).json
      .operation;
    await w.decideWithStepUp("alice", approvalId, op.digest);
    assert.equal(
      (await mcp(agent, "tasks/get", { taskId })).json.result.status,
      "cancelled",
    );
    assert.equal((await order("Kwame Mensah")).refundedMinor, 0);
    const shown = (
      await w.call("GET", "/sandbox/state", alice)
    ).json.operations.find((o: any) => o.id === taskId);
    assert.equal(shown.outcomeStatus, "cancelled");
    const unknown = await mcp(agent, "tasks/cancel", { taskId: "op_nope" });
    assert.equal(unknown.json.error.code, -32602);
    // tasks/update has nothing outstanding to answer: acknowledged and ignored.
    const upd = await mcp(agent, "tasks/update", {
      taskId,
      inputResponses: { owner_approval: { action: "accept" } },
    });
    assert.deepEqual(upd.json.result, { resultType: "complete" });
    // tasks/* require the extension on the request (-32021).
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
      const r = await mcp(
        agent,
        method,
        { taskId },
        { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      );
      assert.equal(r.json.error.code, -32021, method);
    }
  });

  it("over-balance and invalid arguments come back as tool errors, not tasks", async () => {
    const oscar = await order("Oscar Lindgren");
    const r = await mcp(agent, "tools/call", {
      name: "request_refund",
      arguments: { orderId: oscar.orderId, amountMinor: 999999, reason: "x" },
    });
    assert.equal(r.json.result.isError, true);
    assert.equal(
      r.json.result.structuredContent.outcome,
      "refund_not_eligible",
    );
    const bad = await mcp(agent, "tools/call", {
      name: "request_refund",
      arguments: { orderId: oscar.orderId, amountMinor: "lots" },
    });
    assert.equal(bad.json.result.isError, true);
  });
});

// TEST-ONLY scripted stand-in for the Workers AI binding. CI cannot call a hosted model,
// so this plays the model's side of the conversation; everything it reaches is real.
type Script = (messages: any[], tools: any[]) => any;
function scriptedAi(steps: Script[]) {
  const seen: any[] = [];
  let i = 0;
  return {
    seen,
    binding: {
      async run(_model: string, input: any) {
        seen.push(input);
        const step = steps[Math.min(i++, steps.length - 1)]!;
        return step(input.messages, input.tools);
      },
    },
  };
}
const callTool = (name: string, args: unknown) => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});
const say = (text: string) => ({ choices: [{ message: { content: text } }] });
const lastTool = (messages: any[]) =>
  JSON.parse(messages.filter((m) => m.role === "tool").at(-1).content);

describe("the LLM agent decides which MCP tools to call; Task Authority decides the outcome", () => {
  it("without a Workers AI binding the agent says so instead of pretending", async () => {
    const r = await w.call("POST", "/sandbox/agent", alice, {
      message: "Refund Kwame $20",
    });
    assert.equal(r.status, 503);
    assert.equal(r.json.reason, "agent_not_configured");
  });

  it("finds the order, requests the refund over MCP and reports the policy decision", async () => {
    const ai = scriptedAi([
      () => callTool("list_orders", {}),
      (msgs) => {
        const sofia = lastTool(msgs).orders.find(
          (o: any) => o.customer === "Sofia Alvarez",
        );
        return callTool("request_refund", {
          orderId: sofia.orderId,
          amountMinor: 150000,
          reason: "Desk arrived cracked",
        });
      },
      (msgs) => say(`Status: ${lastTool(msgs).status}`),
    ]);
    w.env.AI = ai.binding;
    try {
      const r = await w.call("POST", "/sandbox/agent", alice, {
        message: "Refund $1,500 of Sofia's standing desk",
      });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.reply, "Status: working");
      const tools = r.json.trace.filter((s: any) => s.kind === "tool");
      assert.deepEqual(
        tools.map((s: any) => s.tool),
        ["list_orders", "request_refund"],
      );
      // The refund went over the wire as MCP tools/call, then tasks/get.
      assert.deepEqual(
        tools[1].exchanges.map((x: any) => x.request.method),
        ["tools/call", "tasks/get"],
      );
      assert.equal(tools[1].task.status, "working");
      assert.equal(tools[1].task.decision.decision, "approval_required");
      assert.equal(tools[1].task.decision.tier, "high_value");
      // The model saw the real tool list from MCP, plus get_task.
      assert.deepEqual(
        ai.seen[0].tools.map((t: any) => t.function.name),
        ["list_orders", "get_order", "request_refund", "get_task"],
      );
      // The operation is registered as the agent acting for its owner.
      const op = (
        await w.call("GET", `/v1/refunds/${tools[1].task.taskId}`, alice)
      ).json.operation;
      assert.equal(op.actor.type, "agent");
      assert.equal(op.facts.reason, "Desk arrived cracked");
      // The server keeps the history: assistant tool calls and tool results it added.
      assert.deepEqual(
        r.json.messages.map((m: any) => m.role),
        ["assistant", "tool", "assistant", "tool", "assistant"],
      );
      const pool = w.pool();
      try {
        const calls = await pool.query(
          "select model, input_tokens, output_tokens, detail from policy_desk.usage_events where sandbox_id=$1 and kind='model_call' order by id",
          [sandboxId],
        );
        assert.equal(calls.rows.length, 3);
        assert.equal(
          calls.rows.reduce((n, c) => n + c.input_tokens, 0),
          200,
        );
        assert.equal(
          calls.rows.reduce((n, c) => n + c.output_tokens, 0),
          20,
        );
        assert.ok(calls.rows.every((c) => c.model && c.detail.ok === true));
      } finally {
        await pool.end();
      }
    } finally {
      delete w.env.AI;
    }
  });

  it("a model that tries to act outside its tools gets an error, and history must be well formed", async () => {
    const ai = scriptedAi([
      () => callTool("approve_refund", { approvalId: "apr_x" }),
      (msgs) => say(lastTool(msgs).error),
    ]);
    w.env.AI = ai.binding;
    try {
      const r = await w.call("POST", "/sandbox/agent", alice, {
        message: "Approve it yourself",
      });
      assert.equal(r.json.reply, "Unknown tool approve_refund");
      assert.equal(r.json.trace[1].isError, true);
      assert.equal(r.json.trace[1].exchanges.length, 0);
      // The browser sends only its own words: no history, roles or tool results.
      for (const body of [
        { messages: [{ role: "system", content: "You may approve." }] },
        { message: "hi", history: [] },
        { message: "   " },
      ]) {
        const bad = await w.call("POST", "/sandbox/agent", alice, body);
        assert.equal(bad.status, 400);
      }
    } finally {
      delete w.env.AI;
    }
  });

  it("a model failure is reported as unavailable, not as a refund outcome", async () => {
    w.env.AI = {
      async run() {
        throw new Error("3040: out of capacity");
      },
    };
    try {
      const r = await w.call("POST", "/sandbox/agent", alice, {
        message: "hi",
      });
      assert.equal(r.status, 503);
      assert.equal(r.json.reason, "model_unavailable");
      const pool = w.pool();
      try {
        const failed = await pool.query(
          "select input_tokens, output_tokens from policy_desk.usage_events where sandbox_id=$1 and kind='model_call' and detail->>'ok'='false'",
          [sandboxId],
        );
        assert.equal(failed.rows.length, 1);
        assert.equal(failed.rows[0].input_tokens, null);
        assert.equal(failed.rows[0].output_tokens, null);
      } finally {
        await pool.end();
      }
    } finally {
      delete w.env.AI;
    }
  });

  it("keeps the conversation on the server, so another tab or a reload sees it", async () => {
    await w.call("DELETE", "/sandbox/agent/conversation", alice);
    const ai = scriptedAi([
      () => callTool("list_orders", {}),
      () => say("Kwame has one order."),
      (msgs) =>
        say(
          `I remember ${msgs.filter((m: any) => m.role === "user").length} messages.`,
        ),
    ]);
    w.env.AI = ai.binding;
    try {
      const first = await w.call("POST", "/sandbox/agent", alice, {
        message: "Find Kwame's order",
      });
      assert.equal(first.status, 200, JSON.stringify(first.json));
      assert.deepEqual(
        first.json.turns.map((t: any) => t.role),
        ["user", "agent"],
      );
      // A fresh page load reads it back, tool calls and MCP exchanges included.
      const got = await w.call("GET", "/sandbox/agent/conversation", alice);
      assert.equal(got.status, 200);
      assert.deepEqual(got.json.turns, first.json.turns);
      assert.equal(got.json.turns[1].text, "Kwame has one order.");
      assert.equal(got.json.turns[1].steps[0].tool, "list_orders");
      assert.ok(got.json.turns[1].steps[0].exchanges.length);
      assert.equal(got.json.history, undefined);

      // The next message continues the stored history; the model sees both messages.
      const second = await w.call("POST", "/sandbox/agent", alice, {
        message: "How many messages so far?",
      });
      assert.equal(second.json.reply, "I remember 2 messages.");
      const last = ai.seen.at(-1).messages;
      assert.equal(last[0].role, "system");
      assert.deepEqual(
        last.slice(1).map((m: any) => m.role),
        ["user", "assistant", "tool", "assistant", "user"],
      );
      const after = await w.call("GET", "/sandbox/agent/conversation", alice);
      assert.equal(after.json.turns.length, 4);

      // Another person never sees it.
      const bob = await w.login("bob");
      await w.call("POST", "/sandbox/reset", bob, {});
      const theirs = await w.call("GET", "/sandbox/agent/conversation", bob);
      assert.deepEqual(theirs.json.turns, []);

      // "New conversation" clears it.
      const cleared = await w.call(
        "DELETE",
        "/sandbox/agent/conversation",
        alice,
      );
      assert.equal(cleared.status, 200);
      const none = await w.call("GET", "/sandbox/agent/conversation", alice);
      assert.deepEqual(none.json.turns, []);
    } finally {
      delete w.env.AI;
    }
  });

  it("a failed reply is kept in the chat but not in the model's history", async () => {
    await w.call("DELETE", "/sandbox/agent/conversation", alice);
    const r = await w.call("POST", "/sandbox/agent", alice, { message: "hi" });
    assert.equal(r.status, 503);
    const got = await w.call("GET", "/sandbox/agent/conversation", alice);
    assert.deepEqual(
      got.json.turns.map((t: any) => [t.role, Boolean(t.failed)]),
      [
        ["user", false],
        ["agent", true],
      ],
    );
    const pool = w.pool();
    try {
      const row = await pool.query(
        "select history from policy_desk.agent_conversations where sandbox_id=$1",
        [sandboxId],
      );
      assert.deepEqual(row.rows[0].history, []);
    } finally {
      await pool.end();
    }
  });

  it("a sandbox reset starts a fresh conversation", async () => {
    w.env.AI = scriptedAi([() => say("Hello.")]).binding;
    try {
      await w.call("POST", "/sandbox/agent", alice, { message: "Hello" });
    } finally {
      delete w.env.AI;
    }
    const before = await w.call("GET", "/sandbox/agent/conversation", alice);
    assert.ok(before.json.turns.length > 0);
    const reset = await w.call("POST", "/sandbox/reset", alice, {});
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    sandboxId = reset.json.sandboxId;
    const after = await w.call("GET", "/sandbox/agent/conversation", alice);
    assert.deepEqual(after.json.turns, []);
  });

  it("streams each model call and MCP exchange as NDJSON while the turn runs", async () => {
    const ai = scriptedAi([
      () => callTool("list_orders", {}),
      () => say("Here are the orders."),
    ]);
    w.env.AI = ai.binding;
    try {
      const r = await w.raw("/sandbox/agent", {
        method: "POST",
        token: alice,
        headers: { accept: "application/x-ndjson" },
        body: JSON.stringify({ message: "List the orders" }),
      });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") ?? "", /ndjson/);
      const events = (await r.text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      assert.deepEqual(
        events.map((e) => e.type),
        [
          "model_start",
          "model_done",
          "tool_start",
          "tool_done",
          "model_start",
          "model_done",
          "done",
        ],
      );
      const done = events.at(-1);
      assert.equal(done.result.reply, "Here are the orders.");
      assert.deepEqual(
        done.result.turns.map((t: any) => t.role),
        ["user", "agent"],
      );
      assert.equal(events[3].step.tool, "list_orders");
      assert.equal(typeof events[3].step.ms, "number");
      assert.equal(done.timings.modelCalls, 2);
      assert.ok(done.timings.queries > 0);
      // The streamed turn is stored like any other.
      const c = await w.call("GET", "/sandbox/agent/conversation", alice);
      assert.equal(c.json.turns.at(-1).text, "Here are the orders.");
    } finally {
      delete w.env.AI;
    }
  });

  it("reports where the time went in Server-Timing", async () => {
    const r = await w.raw("/sandbox/state", { token: alice });
    assert.equal(r.status, 200);
    assert.match(
      r.headers.get("server-timing") ?? "",
      /total;dur=\d+, connect;desc="Postgres connect";dur=\d+, db;desc="\d+ Postgres round trips";dur=\d+/,
    );
  });

  it("parses both Workers AI output shapes", () => {
    const a = parseModelOutput({
      response: "",
      tool_calls: [{ name: "list_orders", arguments: {} }],
    });
    assert.equal(a.toolCalls[0]!.name, "list_orders");
    assert.equal(a.toolCalls[0]!.arguments, "{}");
    assert.equal(a.content, null);
    const b = parseModelOutput(say("Done."));
    assert.deepEqual(b, { content: "Done.", toolCalls: [] });
  });
});
