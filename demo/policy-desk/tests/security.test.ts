import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { startWorld, type World } from "./helpers/world.js";

let w: World;
before(async () => {
  w = await startWorld();
});
after(async () => w.close());

describe("DPoP sender constraint on the Worker's own endpoints", () => {
  it("refuses a DPoP-bound token sent as Bearer, accepts a fresh proof once, refuses a replay", async () => {
    const rev = await w.reviewer("carol");
    const bearer = await w.call("GET", "/sandbox/me", rev.token);
    assert.equal(bearer.status, 401);
    assert.equal(bearer.json.reason, "invalid_identity");

    const proof = await rev.prove("GET", "/sandbox/me");
    const ok = await w.raw("/sandbox/me", { token: rev.token, dpop: proof });
    assert.equal(ok.status, 200, await ok.clone().text());

    const replay = await w.raw("/sandbox/me", {
      token: rev.token,
      dpop: proof,
    });
    assert.equal(replay.status, 401);

    const wrongPath = await rev.prove("GET", "/sandbox/state");
    const mismatch = await w.raw("/sandbox/me", {
      token: rev.token,
      dpop: wrongPath,
    });
    assert.equal(mismatch.status, 401);

    const refund = await w.call("POST", "/v1/refunds", rev.token, {
      orderId: "ord_x",
      amountMinor: 100,
    });
    assert.equal(refund.status, 401);
  });
});

describe("refund idempotency is scoped to the sandbox", () => {
  it("the same Idempotency-Key in two sandboxes yields two independent refunds", async () => {
    const agent = (
      (await (
        await fetch(`${w.oidc.issuer}oauth/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: "agent",
            client_secret: "agt-s",
            audience: w.env.TASK_AUTHORITY_AUDIENCE!,
          }),
        })
      ).json()) as any
    ).access_token as string;
    for (const user of ["alice", "bob"]) {
      const t = await w.login(user);
      assert.equal((await w.call("POST", "/sandbox/reset", t, {})).status, 200);
      const sandboxId = (await w.call("GET", "/sandbox/me", t)).json.sandboxId;
      const orderId = (await w.call("GET", "/sandbox/orders", t)).json.orders[0]
        .orderId as string;
      const r = await w.call(
        "POST",
        "/v1/refunds",
        agent,
        { orderId, amountMinor: 2000 },
        {
          "x-policy-desk-sandbox": sandboxId,
          "idempotency-key": "shared-key-0001",
        },
      );
      assert.equal(r.status, 201, JSON.stringify(r.json));
    }
    const pool = w.pool();
    try {
      const rows = await pool.query(
        "select tenant_id from policy_desk.refunds where idempotency_key like '%shared-key-0001'",
      );
      // One executed refund per sandbox; before the fix the second sandbox got the first one's.
      assert.equal(rows.rowCount, 2);
      assert.equal(new Set(rows.rows.map((r) => r.tenant_id)).size, 2);
    } finally {
      await pool.end();
    }
  });
});

describe("static pages", () => {
  it("cannot be framed by another site (the approval page approves in one click)", () => {
    const headers = readFileSync(
      new URL("../web/_headers", import.meta.url),
      "utf8",
    );
    const block = headers.split(/\n(?=\S)/).find((b) => b.startsWith("/*"));
    assert.ok(block, "a rule for every path");
    assert.match(block, /frame-ancestors 'none'/);
    assert.match(block, /X-Frame-Options: DENY/);
    const build = readFileSync(
      new URL("../web/build.mjs", import.meta.url),
      "utf8",
    );
    assert.match(build, /"_headers"/, "the build ships _headers with dist");
  });
});
