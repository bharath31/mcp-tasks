const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const net = require("node:net");
const cwd = resolve(__dirname, "..");
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function start(port, db) {
  const child = spawn(process.execPath, ["server/start.mjs"], {
    cwd,
    env: {
      ...process.env,
      SHOPPING_FIXTURE: "1",
      SHOPPING_FIXTURE_DB: db,
      PORT: String(port),
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 200; i++) {
    if (out.includes("Fixture only:")) return child;
    if (child.exitCode !== null) throw Error(out);
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw Error(`startup timeout ${out}`);
}
async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}

test(
  "fixture loopback HTTP: grants, reviews, stale terms, retries, restart and CSRF",
  { timeout: 90000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "shopping-fixture-"));
    const db = join(dir, "state.sqlite");
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    let child = await start(port, db);
    let cookie = "";
    async function call(path, method = "GET", data, headers = {}) {
      const r = await fetch(origin + "/api" + path, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(method === "GET"
            ? {}
            : { origin, "content-type": "application/json" }),
          ...headers,
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(data ?? {}) }),
      });
      if (r.headers.get("set-cookie"))
        cookie = r.headers.get("set-cookie").split(";")[0];
      return { status: r.status, data: await r.json() };
    }
    try {
      assert.equal((await call("/session")).data.actor.kind, "agent");
      assert.equal(
        (
          await call(
            "/fixture/grant",
            "POST",
            {},
            { origin: "http://evil.test" },
          )
        ).status,
        403,
      );
      const denied = await new Promise((resolve, reject) => {
        require("node:http")
          .get(
            origin + "/api/catalog",
            { headers: { host: "evil.test" } },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          )
          .on("error", reject);
      });
      assert.equal(denied, 403);
      const proxied = await fetch(origin + "/api/catalog", {
        headers: { "x-forwarded-for": "127.0.0.1" },
      });
      assert.equal(proxied.status, 403);
      let c = (await call("/carts", "POST")).data.cart;
      await call(`/carts/${c.id}/items`, "PUT", {
        items: [{ productId: "mug", quantity: 1 }],
      });
      assert.equal((await call("/addresses")).status, 403);
      await call("/fixture/grant", "POST");
      await call(`/carts/${c.id}/link`, "POST");
      let q = (
        await call(`/carts/${c.id}/quote`, "POST", {
          shippingAddressId: "fixture-home",
        })
      ).data.quote;
      const complete = () =>
        call(
          `/checkouts/${q.id}/complete`,
          "POST",
          {},
          { "idempotency-key": "retry" },
        );
      assert.equal((await complete()).data.status, "approval_required");
      assert.equal(
        (
          await call(
            `/checkouts/${q.id}/complete`,
            "POST",
            { approver: "user", actor: "human", assurance: "passkey" },
            { "idempotency-key": "retry" },
          )
        ).data.status,
        "approval_required",
      );
      assert.equal(
        (await call(`/checkouts/${q.id}/approve`, "POST")).status,
        403,
      );
      await call(`/checkouts/${q.id}/confirm`, "POST");
      const first = await complete();
      assert.equal(first.data.status, "completed");
      assert.equal((await complete()).data.order.id, first.data.order.id);
      const retries = await Promise.all([complete(), complete(), complete()]);
      for (const retry of retries)
        assert.equal(retry.data.order.id, first.data.order.id);
      c = (await call("/carts", "POST")).data.cart;
      await call(`/carts/${c.id}/items`, "PUT", {
        items: [{ productId: "mug", quantity: 4 }],
      });
      q = (
        await call(`/carts/${c.id}/quote`, "POST", {
          shippingAddressId: "fixture-home",
        })
      ).data.quote;
      assert.equal(
        (await complete()).data.status,
        "customer_verification_required",
      );
      await call("/fixture/human", "POST");
      assert.equal(
        (await call(`/checkouts/${q.id}/approve`, "POST")).data.status,
        "review_recorded",
      );
      await call("/fixture/agent", "POST");
      await call(`/carts/${c.id}/items`, "PUT", {
        items: [{ productId: "mug", quantity: 5 }],
      });
      assert.equal((await complete()).data.code, "stale_quote");
      q = (
        await call(`/carts/${c.id}/quote`, "POST", {
          shippingAddressId: "fixture-home",
        })
      ).data.quote;
      assert.equal(
        (await complete()).data.status,
        "customer_verification_required",
      );
      await call("/fixture/human", "POST");
      await call(`/checkouts/${q.id}/approve`, "POST");
      await call("/fixture/agent", "POST");
      const high = await complete();
      assert.equal(high.data.status, "completed");
      assert.equal((await complete()).data.order.id, high.data.order.id);
      assert.equal((await call("/orders")).data.orders.length, 2);
      await stop(child);
      child = await start(port, db);
      cookie = "";
      await call("/session");
      await call("/fixture/grant", "POST");
      const orders = (await call("/orders")).data.orders;
      assert.equal(orders.length, 2);
      assert.ok(orders.some((x) => x.id === first.data.order.id));
    } finally {
      await stop(child);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "fixture server requires explicit opt in",
  { timeout: 10000 },
  async () => {
    const child = spawn(process.execPath, ["server/start.mjs"], {
      cwd,
      env: { ...process.env, SHOPPING_FIXTURE: "" },
      stdio: "ignore",
    });
    const code = await new Promise((r) => child.on("exit", r));
    assert.notEqual(code, 0);
  },
);

test(
  "fixture restart restores pending agent and safely abandons only confirmed absent claims",
  { timeout: 90000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixture-recover-")),
      db = join(dir, "state.sqlite"),
      port = await freePort(),
      origin = `http://127.0.0.1:${port}`;
    let child = await start(port, db),
      cookie = "";
    async function call(path, method = "GET", data = {}) {
      const r = await fetch(origin + "/api" + path, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(method === "GET"
            ? {}
            : { origin, "content-type": "application/json" }),
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(data) }),
      });
      if (r.headers.get("set-cookie"))
        cookie = r.headers.get("set-cookie").split(";")[0];
      return { status: r.status, data: await r.json() };
    }
    try {
      await call("/session");
      const guest = (await call("/carts", "POST")).data.cart;
      const orphan = (await call("/carts", "POST")).data.cart;
      await call(`/carts/${guest.id}/items`, "PUT", {
        items: [{ productId: "tea", quantity: 1 }],
      });
      await call("/fixture/grant", "POST");
      await call(`/carts/${guest.id}/link`, "POST");
      const q1 = (
        await call(`/carts/${guest.id}/quote`, "POST", {
          shippingAddressId: "fixture-home",
        })
      ).data.quote;
      const cart2 = (await call("/carts", "POST")).data.cart;
      await call(`/carts/${cart2.id}/items`, "PUT", {
        items: [{ productId: "tea", quantity: 1 }],
      });
      const q2 = (
        await call(`/carts/${cart2.id}/quote`, "POST", {
          shippingAddressId: "fixture-home",
        })
      ).data.quote;
      await stop(child);
      // Simulate two crash windows: accepted provider order and claim before provider insertion.
      const { DatabaseSync } = require("node:sqlite");
      const sqlite = new DatabaseSync(db);
      for (const q of [q1, q2])
        sqlite
          .prepare(
            "INSERT INTO checkout_executions VALUES (?, ?, ?, 'processing', ?, NULL)",
          )
          .run(q.operationId, q.id, "fixture-customer", q.operationId);
      const snapshot = sqlite
        .prepare("SELECT data FROM quotes WHERE id = ?")
        .get(q1.id).data;
      sqlite
        .prepare("INSERT INTO fixture_provider_orders VALUES (?, ?, ?)")
        .run(q1.operationId, "accepted-before-restart", snapshot);
      sqlite.close();
      child = await start(port, db);
      cookie = "";
      await call("/session");
      assert.equal(
        (await call(`/checkouts/${q1.id}/reconcile`, "POST")).status,
        403,
      );
      await call("/fixture/grant", "POST");
      assert.equal(
        (await call(`/carts/${orphan.id}/link`, "POST")).status,
        403,
      );
      const resolved = await call(`/checkouts/${q1.id}/reconcile`, "POST");
      assert.equal(resolved.data.order.id, "accepted-before-restart");
      assert.equal(
        (await call(`/checkouts/${q2.id}/reconcile`, "POST")).data.status,
        "provider_confirmed_absent",
      );
      const recovery = await Promise.all(
        Array.from({ length: 5 }, () =>
          call(`/checkouts/${q2.id}/abandon`, "POST"),
        ),
      );
      assert.ok(recovery.every((r) => r.data.status === "abandoned"));
      assert.equal(
        (await call(`/checkouts/${q2.id}/reconcile`, "POST")).data.status,
        "abandoned",
      );
      const next = (
        await call(`/carts/${cart2.id}/quote`, "POST", {
          shippingAddressId: "fixture-home",
        })
      ).data.quote;
      assert.notEqual(next.operationId, q2.operationId);
      const inspect = new DatabaseSync(db);
      assert.equal(
        inspect
          .prepare(
            "SELECT count(*) AS n FROM fixture_provider_orders WHERE provider_key = ?",
          )
          .get(q2.operationId).n,
        0,
      );
      assert.equal(
        inspect
          .prepare(
            "SELECT status FROM checkout_executions WHERE operation_id = ?",
          )
          .get(q2.operationId).status,
        "abandoned",
      );
      const oldSnapshot = JSON.parse(
        inspect.prepare("SELECT data FROM quotes WHERE id = ?").get(q2.id).data,
      );
      const newSnapshot = JSON.parse(
        inspect.prepare("SELECT data FROM quotes WHERE id = ?").get(next.id)
          .data,
      );
      inspect
        .prepare(
          "INSERT INTO checkout_executions VALUES (?, ?, ?, 'processing', ?, NULL)",
        )
        .run(next.operationId, next.id, "fixture-customer", next.operationId);
      inspect.close();
      const { fixtureApi } = await import("../server/fixture.mjs");
      const adapter = fixtureApi(db, origin);
      try {
        // A delayed placement cannot cross the atomic abandonment fence.
        assert.equal(
          await adapter.provider.place({
            quote: oldSnapshot,
            idempotencyKey: q2.operationId,
          }),
          null,
        );
        // Race a live provider insertion against absence-abandonment: exactly one wins.
        const [abandon, placement] = await Promise.all([
          call(`/checkouts/${next.id}/abandon`, "POST"),
          adapter.provider.place({
            quote: newSnapshot,
            idempotencyKey: next.operationId,
          }),
        ]);
        if (placement) {
          assert.notEqual(abandon.data.status, "abandoned");
          assert.equal(
            (await call(`/checkouts/${next.id}/reconcile`, "POST")).data.order
              .id,
            placement.id,
          );
        } else {
          assert.equal(abandon.data.status, "abandoned");
        }
      } finally {
        adapter.close();
      }
    } finally {
      await stop(child);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
