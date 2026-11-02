import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanupExpired } from "../src/cleanup.js";
import { openHost } from "../src/host.js";
import { startWorld, ORIGIN, type World } from "./helpers/world.js";

let w: World;
let alice: string;
let carol: string;
let aliceSandbox: string;
let carolSandbox: string;
before(async () => {
  w = await startWorld();
  alice = await w.login("alice");
  carol = await w.login("carol");
  aliceSandbox = (await w.call("POST", "/sandbox/reset", alice, {})).json
    .sandboxId;
  carolSandbox = (await w.call("POST", "/sandbox/reset", carol, {})).json
    .sandboxId;
});
after(async () => w.close());

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/tasks": {} },
  },
};
/** What Claude Code sends after `claude mcp add --header "Authorization: Bearer <key>"`: no sandbox header. */
async function mcp(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const r = await w.raw("/mcp", {
    method: "POST",
    token,
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: META },
    }),
  });
  return {
    status: r.status,
    json: (await r.json()) as any,
    headers: r.headers,
  };
}
const order = async (who: string, customer: string) =>
  (await w.call("GET", "/sandbox/orders", who)).json.orders.find(
    (o: any) => o.customer === customer,
  );

describe("sandbox agent keys: a visitor's own agent over MCP", () => {
  let key: string;

  it("is off until the visitor connects an agent, then hands out a ready command", async () => {
    const before = await w.call("GET", "/sandbox/agent-key", alice);
    assert.equal(before.status, 200);
    assert.equal(before.json.available, true);
    assert.equal(before.json.connected, false);
    assert.equal(before.json.mcpUrl, `${ORIGIN}/mcp`);
    const info = await w.call("GET", "/sandbox/info");
    assert.equal(info.json.agent.externalAgents, true);

    const r = await w.call("POST", "/sandbox/agent-key", alice, {});
    assert.equal(r.status, 201, JSON.stringify(r.json));
    key = r.json.token;
    assert.ok(key.split(".").length === 3, "an Auth0-issued JWT");
    assert.equal(r.json.tokenType, "Bearer");
    assert.equal(r.json.mcpUrl, `${ORIGIN}/mcp`);
    assert.equal(
      r.json.claudeCode,
      `claude mcp add --transport http policy-desk ${ORIGIN}/mcp --header "Authorization: Bearer ${key}"`,
    );
    assert.equal(
      r.json.mcpJson.mcpServers["policy-desk"].headers.Authorization,
      `Bearer ${key}`,
    );
    // Only a hash is stored.
    const pool = w.pool();
    const rows = await pool.query("select * from policy_desk.agent_keys");
    await pool.end();
    assert.equal(rows.rows.length, 1);
    assert.doesNotMatch(JSON.stringify(rows.rows), new RegExp(key.slice(-20)));

    const after = await w.call("GET", "/sandbox/agent-key", alice);
    assert.equal(after.json.connected, true);
    assert.ok(Date.parse(after.json.expiresAt) > Date.now());
  });

  it("the agent needs no sandbox id, and the refund waits for the visitor's fresh passkey", async () => {
    const tools = await mcp(key, "tools/list");
    assert.equal(tools.status, 200, JSON.stringify(tools.json));
    assert.ok(
      tools.json.result.tools.some((t: any) => t.name === "request_refund"),
    );

    const dana = await order(alice, "Dana Whitfield");
    const small = await mcp(key, "tools/call", {
      name: "request_refund",
      arguments: { orderId: dana.orderId, amountMinor: 4000, reason: "Torn" },
    });
    assert.equal(small.json.result.status, "completed", JSON.stringify(small));

    const mei = await order(alice, "Mei Tanaka");
    const big = await mcp(key, "tools/call", {
      name: "request_refund",
      arguments: { orderId: mei.orderId, amountMinor: 13900, reason: "Dead" },
    });
    const taskId = big.json.result.taskId;
    assert.equal(big.json.result.status, "working", JSON.stringify(big));
    assert.match(
      big.json.result.statusMessage,
      new RegExp(`/review\\?approval=.*&sandbox=${aliceSandbox}`),
    );
    const meta = big.json.result._meta["task-authority/decision"];
    assert.equal(meta.decision, "approval_required");

    const op = (await w.call("GET", `/v1/refunds/${taskId}`, alice)).json
      .operation;
    // The agent acts under Alex's delegation, not as the visitor, so the visitor may approve.
    // The second factor from sign-in is still not enough for this tier.
    const signInMfa = await w.reviewer("alice");
    const reused = await signInMfa.post(
      `/v1/approval-requests/${meta.approvalId}/decisions`,
      { decision: "approve", operationDigest: op.digest },
    );
    assert.equal(reused.status, 403, JSON.stringify(reused.json));
    assert.equal(
      (await mcp(key, "tasks/get", { taskId })).json.result.status,
      "working",
    );
    const d = await w.decideWithStepUp("alice", meta.approvalId, op.digest);
    assert.equal(d.status, 200, JSON.stringify(d.json));

    const ran = await mcp(key, "tasks/get", { taskId });
    assert.equal(ran.json.result.status, "completed", JSON.stringify(ran));
    assert.equal(ran.json.result.result.structuredContent.outcome, "refunded");
    assert.equal((await order(alice, "Mei Tanaka")).refundedMinor, 13900);

    const status = await w.call("GET", "/sandbox/agent-key", alice);
    assert.ok(status.json.lastUsedAt, "records when the agent last called");
  });

  it("the same key works on the REST path, and is decided the same way", async () => {
    const kwame = await order(alice, "Kwame Mensah");
    const r = await w.call(
      "POST",
      "/v1/refunds",
      key,
      { orderId: kwame.orderId, amountMinor: 2500, reason: "Late" },
      { "idempotency-key": "agent-key-rest-1" },
    );
    assert.equal(r.status, 201, JSON.stringify(r.json));
  });

  it("cannot reach another sandbox, even by naming it", async () => {
    const r = await mcp(
      key,
      "tools/list",
      {},
      {
        "x-policy-desk-sandbox": carolSandbox,
      },
    );
    assert.equal(r.status, 403);
    assert.match(r.json.error.message, /different sandbox/);
    // Naming its own sandbox is harmless.
    const own = await mcp(
      key,
      "tools/list",
      {},
      {
        "x-policy-desk-sandbox": aliceSandbox,
      },
    );
    assert.equal(own.status, 200);
  });

  it("an unbound token of the external client is refused", async () => {
    const res = await fetch(`${w.oidc.issuer}oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "external-agent",
        client_secret: "ext-s",
        audience: w.env.TASK_AUTHORITY_AUDIENCE!,
      }),
    });
    const unbound = ((await res.json()) as any).access_token as string;
    const r = await mcp(
      unbound,
      "tools/list",
      {},
      {
        "x-policy-desk-sandbox": aliceSandbox,
      },
    );
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /invalid_token/);
  });

  it("a new key replaces the old one, and disconnecting revokes it", async () => {
    const next = (await w.call("POST", "/sandbox/agent-key", alice, {})).json
      .token as string;
    assert.notEqual(next, key);
    const old = await mcp(key, "tools/list");
    assert.equal(old.status, 401);
    assert.match(
      old.json.error.message,
      /replaced, disconnected or has expired/,
    );
    assert.equal((await mcp(next, "tools/list")).status, 200);

    const del = await w.call("DELETE", "/sandbox/agent-key", alice);
    assert.equal(del.status, 200);
    assert.equal(del.json.revoked, 1);
    assert.equal((await mcp(next, "tools/list")).status, 401);
    assert.equal(
      (await w.call("GET", "/sandbox/agent-key", alice)).json.connected,
      false,
    );
  });

  it("keys die with their sandbox", async () => {
    const k = (await w.call("POST", "/sandbox/agent-key", carol, {})).json
      .token as string;
    assert.equal((await mcp(k, "tools/list")).status, 200);
    const pool = w.pool();
    await pool.query(
      "update policy_desk.sandboxes set expires_at = now() - interval '1 minute' where id=$1",
      [carolSandbox],
    );
    const expired = await mcp(k, "tools/list");
    assert.equal(expired.status, 410);
    const host = await openHost(w.env, new Request(ORIGIN));
    try {
      await cleanupExpired(host);
    } finally {
      await host.conn.close();
    }
    const rows = await pool.query(
      "select count(*)::int n from policy_desk.agent_keys where sandbox_id=$1",
      [carolSandbox],
    );
    assert.equal(rows.rows[0].n, 0);
    await pool.end();
  });

  it("a missing key gets an MCP error that says where to get one", async () => {
    const r = await w.raw("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: META },
      }),
    });
    assert.equal(r.status, 401);
    const b = (await r.json()) as any;
    assert.match(b.error.message, /Connect your agent/);
  });
});
