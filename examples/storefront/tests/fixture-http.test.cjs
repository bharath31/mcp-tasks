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
