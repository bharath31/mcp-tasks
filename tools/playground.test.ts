import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  POLICY_TEMPLATES,
  validatePolicy,
} from "../auth0/service/src/policies.js";
import { evaluateExample, main } from "./playground.js";

const policy = validatePolicy(POLICY_TEMPLATES.refunds);

test("playground uses the service's refund rules at every threshold", () => {
  for (const [amount, decision, tier, quorum] of [
    [5000, "allow", undefined, undefined],
    [10000, "allow", undefined, undefined],
    [10001, "approval_required", "routine", 1],
    [100000, "approval_required", "routine", 1],
    [100001, "approval_required", "high_value", 2],
  ] as const) {
    const result = evaluateExample(policy, amount);
    assert.deepEqual(
      [result.decision, result.tier, result.quorum],
      [decision, tier, quorum],
    );
  }
  assert.equal(
    evaluateExample(policy, 5000, "refund:unlisted").decision,
    "deny",
  );
});

test("default walkthrough shows decisions, matched rules and offline limits", async () => {
  const lines: string[] = [];
  assert.equal(await main([], (s) => lines.push(s)), 0);
  const output = lines.join("\n");
  assert.match(output, /\$50\.00\s+refund:create\s+→ allow/);
  assert.match(output, /\$150\.00\s+refund:create\s+→ approval_required/);
  assert.match(output, /\$1,500\.00\s+refund:create\s+→ approval_required/);
  assert.match(output, /refund:unlisted\s+→ deny/);
  assert.match(output, /rules: high-value; tier: high_value; reviewers: 2/);
  assert.match(output, /no identity or FGA checks/);
  assert.match(output, /usage enforced by the running service/);
});

test("amount override evaluates only the requested amount", async () => {
  const lines: string[] = [];
  assert.equal(
    await main(["--amount-minor", "10001"], (s) => lines.push(s)),
    0,
  );
  assert.match(
    lines.join("\n"),
    /\$100\.01\s+refund:create\s+→ approval_required/,
  );
  assert.equal(lines.filter((s) => s.includes("→")).length, 1);
});

test("invalid options fail with actionable errors rather than evaluating", async () => {
  for (const args of [
    ["--wat"],
    ["--policy"],
    ["--amount-minor"],
    ["--amount-minor", "1.5"],
    ["--amount-minor", "-1"],
    ["--amount-minor", "NaN"],
    ["--amount-minor", "1e3"],
    ["--amount-minor", "9007199254740992"],
    ["--policy", "--amount-minor"],
  ]) {
    const lines: string[] = [];
    assert.equal(await main(args, (s) => lines.push(s)), 1, args.join(" "));
    assert.match(lines[0]!, /^Playground:/);
    assert.ok(!lines.some((s) => s.includes("→")));
  }
  assert.equal(await main(["--help"], () => {}), 0);
});

test("editable policy uses the same validation and reflects changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-playground-"));
  try {
    const file = join(dir, "refunds.json");
    const custom = structuredClone(POLICY_TEMPLATES.refunds!);
    custom.actions["refund:create"]!.rules[0]!.when =
      'actor.type == "agent" && args.amountMinor <= 20000';
    await writeFile(file, JSON.stringify(custom));
    const lines: string[] = [];
    assert.equal(
      await main(["--policy", file, "--amount-minor", "15000"], (s) =>
        lines.push(s),
      ),
      0,
    );
    assert.match(lines.join("\n"), /\$150\.00\s+refund:create\s+→ allow/);
    for (const invalid of [
      "not JSON",
      "{}",
      JSON.stringify({ ...custom, tiers: {} }),
    ]) {
      await writeFile(file, invalid);
      assert.equal(await main(["--policy", file], () => {}), 1);
    }
    assert.equal(
      await main(["--policy", join(dir, "missing.json")], () => {}),
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("documented npm export is clean JSON and round-trips through the playground", async () => {
  // Exercise npm too: without --silent its run-script banner corrupts redirected JSON.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const json = execFileSync(
    npm,
    ["run", "--silent", "task-authority", "--", "policy", "init", "refunds"],
    { encoding: "utf8" },
  );
  assert.equal(validatePolicy(JSON.parse(json)).version, "refunds.v1");
  const dir = await mkdtemp(join(tmpdir(), "mcp-playground-export-"));
  try {
    const file = join(dir, "refunds.json");
    await writeFile(file, json);
    assert.equal(await main(["--policy", file], () => {}), 0);
    assert.equal(
      await readFile(file, "utf8"),
      json,
      "playground must not modify policies",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
