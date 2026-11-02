import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../../tools/task-authority.js";

test("policy CLI encodes API identifiers and forwards separate policy credentials", async () => {
  let requested = "";
  let request: RequestInit | undefined;
  const code = await runCli(
    ["policy", "activate", "https://api.example/refunds", "v2", "--shadow"],
    {
      baseUrl: "http://authority.test",
      token: "admin-token",
      stdout: () => {},
      fetch: async (url, init) => {
        requested = String(url);
        request = init;
        return new Response(JSON.stringify({ version: "v2", shadow: true }), {
          status: 200,
        });
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(
    requested,
    "http://authority.test/v1/policies/https%3A%2F%2Fapi.example%2Frefunds/activate",
  );
  assert.equal(
    (request?.headers as Record<string, string>).authorization,
    "Bearer admin-token",
  );
  assert.deepEqual(JSON.parse(String(request?.body)), {
    version: "v2",
    shadow: true,
  });
});

test("policy CLI returns a failing exit code for service denial and missing simulation version", async () => {
  const output: string[] = [];
  const config = {
    baseUrl: "http://authority.test",
    token: "admin-token",
    stdout: (s: string) => output.push(s),
    fetch: async () =>
      new Response(JSON.stringify({ code: "not_authorized" }), { status: 403 }),
  };
  assert.equal(await runCli(["policy", "list", "api"], config), 1);
  assert.match(output[0]!, /not_authorized/);
  assert.equal(await runCli(["policy", "simulate", "api"], config), 1);
  assert.match(output[1]!, /--version is required/);
});

test("policy CLI authors offline: init, check and explain need no server", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const output: string[] = [];
  const stdout = (s: string) => output.push(s);
  const offline = {
    stdout,
    fetch: async () => {
      throw new Error("offline commands must not call the service");
    },
  };
  assert.equal(await runCli(["policy", "init", "refunds"], offline), 0);
  const document = JSON.parse(output.pop()!);
  const dir = await mkdtemp(join(tmpdir(), "policy-cli-"));
  const file = join(dir, "refunds.json");
  await writeFile(file, JSON.stringify(document));
  assert.equal(await runCli(["policy", "check", file], offline), 0);
  assert.match(output.pop()!, /^ok: .* refunds\.v1/);

  const explain = async (args: object, actor = "agent") => {
    assert.equal(
      await runCli(
        [
          "policy",
          "explain",
          file,
          "refund:create",
          "--args",
          JSON.stringify(args),
          "--actor",
          actor,
        ],
        offline,
      ),
      0,
    );
    return JSON.parse(output.pop()!);
  };
  assert.equal(
    (await explain({ amountMinor: 5000, currency: "usd" })).decision,
    "allow",
  );
  const high = await explain({ amountMinor: 150000, currency: "usd" });
  assert.deepEqual(
    [high.decision, high.tier, high.ruleIds],
    ["approval_required", "high_value", ["high-value"]],
  );
  assert.equal(
    (await explain({ amountMinor: 5000, currency: "usd" }, "human")).tier,
    "routine",
  );

  document.actions["refund:create"].rules[0].when = "args.amount <= 10000";
  await writeFile(file, JSON.stringify(document));
  assert.equal(await runCli(["policy", "check", file], offline), 1);
  assert.match(output.pop()!, /invalid: Undeclared argument: amount/);
  assert.equal(await runCli(["policy", "init", "nope"], offline), 1);
});
