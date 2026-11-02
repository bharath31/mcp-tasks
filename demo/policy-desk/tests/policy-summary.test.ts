import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePolicy } from "../../../auth0/service/src/policies.js";
import {
  DEFAULT_SETTINGS,
  policySummary,
  sandboxPolicy,
  validateSettings,
} from "../src/policy.js";

const decide = (type: "agent" | "human", amountMinor: number) =>
  evaluatePolicy(sandboxPolicy(DEFAULT_SETTINGS, "t"), "refund:create", {
    args: { amountMinor, currency: "USD" },
    actor: { type, id: "x" },
    facts: {},
    relations: {},
    aggregates: {},
  }).decision;

describe("sandbox policy summary", () => {
  it("lists every published rule with its exact CEL condition", () => {
    const doc = sandboxPolicy(DEFAULT_SETTINGS, "t");
    const rules = doc.actions["refund:create"].rules as {
      id: string;
      when: string;
    }[];
    const summary = policySummary(DEFAULT_SETTINGS);
    for (const r of rules)
      assert.equal(
        summary.find((s) => s.id === r.id)?.when,
        r.when,
        `summary must carry rule ${r.id}`,
      );
    const ruleIds = new Set(rules.map((r) => r.id));
    for (const s of summary)
      assert.ok(
        ruleIds.has(s.id) || ["default", "unknown"].includes(s.id),
        `summary line ${s.id} has no rule`,
      );
  });

  it("a human never needs more for a smaller refund", () => {
    assert.equal(decide("human", 5000), "step_up_required");
    assert.equal(decide("human", 60000), "step_up_required");
    assert.equal(decide("human", 150000), "approval_required");
    assert.equal(decide("agent", 5000), "allow");
    assert.equal(decide("agent", 15000), "approval_required");
  });
});

describe("authenticator-app approvals (demo setting)", () => {
  it("are off by default and only ever widen the routine tier", () => {
    const off = sandboxPolicy(DEFAULT_SETTINGS, "t");
    assert.deepEqual(off.tiers.routine.factors, [
      "webauthn-platform",
      "webauthn-roaming",
    ]);
    const on = sandboxPolicy(
      { ...DEFAULT_SETTINGS, allowAuthenticatorApp: true },
      "t",
    );
    assert.ok(on.tiers.routine.factors.includes("otp"));
    assert.equal(on.tiers.routine.assurance, "per_operation");
    assert.ok(!on.tiers.high_value.factors.includes("otp"));
  });
  it("a partial edit keeps the other settings, and the flag must be a boolean", () => {
    const base = {
      ...DEFAULT_SETTINGS,
      allowAuthenticatorApp: true,
      budgetMaxCount: 7,
    };
    const r = validateSettings({ agentAutoLimitMinor: 9000 }, base);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.settings.allowAuthenticatorApp, true);
      assert.equal(r.settings.budgetMaxCount, 7);
    }
    assert.equal(validateSettings({ allowAuthenticatorApp: "yes" }).ok, false);
  });
});
