// The sandbox policy: the Refund template from the service, re-pointed at the
// sandbox resource server, plus one rule showing a human/agent distinction.
// Visitors never submit a policy document: they submit a few numbers that are
// range-checked here, and the Worker builds the document. The approver floor
// (refund_approve) and `unknown_action: deny` are fixed in code, so no edit can
// remove them. Publishing goes through the real /v1/policies API.
import { policyTemplates } from "../../../auth0/service/src/policy-templates.js";
import { RESOURCE_SERVER, type Env } from "./env.js";

export type PolicySettings = {
  /** Agent refunds up to this amount are allowed automatically (inside the budget). */
  agentAutoLimitMinor: number;
  budgetMaxMinor: number;
  budgetMaxCount: number;
  /** Refunds above this amount are high value. */
  highValueAboveMinor: number;
  /**
   * Demo setting, off by default: routine approvals also accept a fresh authenticator-app
   * code (TOTP), still per operation and bound to the challenge, for visitors with no
   * passkey-capable device. High-value approvals always need a passkey or security key.
   */
  allowAuthenticatorApp?: boolean;
};
export const DEFAULT_SETTINGS: PolicySettings = {
  agentAutoLimitMinor: 10000,
  budgetMaxMinor: 50000,
  budgetMaxCount: 20,
  highValueAboveMinor: 100000,
  allowAuthenticatorApp: false,
};
/** Numeric settings and their allowed ranges. */
export const ENVELOPE = {
  agentAutoLimitMinor: [1000, 50000],
  budgetMaxMinor: [1000, 200000],
  budgetMaxCount: [1, 50],
  highValueAboveMinor: [20000, 500000],
} as const;
export const MAX_POLICY_PUBLISHES_PER_HOUR = 10;

export type PolicyIssue = { code: string; message: string; hint: string };
/** `base` supplies every field the input leaves out, so a partial edit keeps the rest. */
export function validateSettings(
  input: unknown,
  base: PolicySettings = DEFAULT_SETTINGS,
): { ok: true; settings: PolicySettings } | { ok: false; issue: PolicyIssue } {
  const o = (input ?? {}) as Record<string, unknown>;
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length)
    return {
      ok: false,
      issue: {
        code: "policy_edit_not_allowed",
        message: `The sandbox only lets you change ${allowed.join(", ")}. "${extra[0]}" is fixed (approvers, unknown-action deny and tiers cannot be edited here).`,
        hint: "Remove the field and resubmit.",
      },
    };
  const s = { ...DEFAULT_SETTINGS, ...base } as Record<string, unknown>;
  if (o.allowAuthenticatorApp !== undefined) {
    if (typeof o.allowAuthenticatorApp !== "boolean")
      return {
        ok: false,
        issue: {
          code: "policy_value_out_of_range",
          message: "allowAuthenticatorApp must be true or false.",
          hint: "Send a boolean.",
        },
      };
    s.allowAuthenticatorApp = o.allowAuthenticatorApp;
  }
  for (const k of allowed) {
    if (k === "allowAuthenticatorApp" || o[k] === undefined) continue;
    const v = o[k];
    const [lo, hi] = ENVELOPE[k as keyof typeof ENVELOPE];
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
      return {
        ok: false,
        issue: {
          code: "policy_value_out_of_range",
          message: `${k} must be a whole number between ${lo} and ${hi}.`,
          hint: k.endsWith("Minor")
            ? "Amounts are in cents."
            : "Pick a smaller range.",
        },
      };
    s[k] = v;
  }
  const out = s as unknown as PolicySettings;
  if (out.highValueAboveMinor <= out.agentAutoLimitMinor)
    return {
      ok: false,
      issue: {
        code: "policy_thresholds_inverted",
        message:
          "The high-value threshold must be above the agent auto-approve limit.",
        hint: "Raise highValueAboveMinor or lower agentAutoLimitMinor.",
      },
    };
  return { ok: true, settings: out };
}

export function sandboxPolicy(
  settings: PolicySettings,
  version: string,
  env: Pick<Env, "HIGH_VALUE_QUORUM"> = {},
) {
  const t = structuredClone(policyTemplates.refunds!) as any;
  t.resource_server = RESOURCE_SERVER;
  t.version = version;
  t.unknown_action = "deny";
  const rules = t.actions["refund:create"].rules;
  rules[0].when = `actor.type == "agent" && args.amountMinor <= ${settings.agentAutoLimitMinor}`;
  rules[0].then.allow.budget.max_amount_minor = settings.budgetMaxMinor;
  rules[0].then.allow.budget.max_count = settings.budgetMaxCount;
  rules[1].when = `args.amountMinor > ${settings.highValueAboveMinor}`;
  // Adaptation: the template requires two reviewers for high value. A public
  // sandbox has one human per sandbox, so the quorum defaults to 1 (set
  // HIGH_VALUE_QUORUM=2 when two real reviewers will take part).
  rules[1].then.approve.quorum = env.HIGH_VALUE_QUORUM === "2" ? 2 : 1;
  // Adaptation: the template's routine tier accepts the MFA from sign-in for an
  // hour, so a reviewer who signed in with a second factor approved agent refunds
  // with no prompt at all. Visitors sign in with email OTP only, and every
  // approval is a fresh passkey or security key bound to that one refund.
  // allowAuthenticatorApp (off by default) adds a fresh authenticator-app code for routine
  // approvals only, for visitors with no passkey-capable device.
  t.tiers.routine = {
    assurance: "per_operation",
    factors: [
      "webauthn-platform",
      "webauthn-roaming",
      ...(settings.allowAuthenticatorApp === true ? ["otp"] : []),
    ],
    max_age: 300,
    batch_max: 5,
  };
  // Adaptation: a human with a fresh MFA session may refund up to the high-value
  // threshold without a second reviewer; the same refund by an agent above its
  // limit needs approval. No lower bound: a smaller refund never needs more.
  rules.splice(1, 0, {
    id: "human-step-up",
    when: `actor.type == "human" && args.amountMinor <= ${settings.highValueAboveMinor}`,
    then: { step_up: { acr: "mfa", max_age: 300 } },
  });
  return t;
}

const usd = (m: number) =>
  `$${(m / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
export type PolicySummaryRule = {
  id: string;
  tier: string;
  /** The rule's CEL condition exactly as published; what the service evaluates. */
  when: string | null;
  /** A plain-English reading of that rule, for people. Never evaluated. */
  text: string;
};
/**
 * The readable view of the policy. Each line carries the condition copied from the
 * document `sandboxPolicy` builds, so the English sits next to the CEL it describes,
 * and a test fails if a rule exists in one but not the other.
 */
export function policySummary(
  s: PolicySettings,
  quorum = 1,
): PolicySummaryRule[] {
  const doc = sandboxPolicy(s, "summary", {
    HIGH_VALUE_QUORUM: quorum === 2 ? "2" : undefined,
  });
  const when = (id: string) =>
    (doc.actions["refund:create"].rules as { id: string; when: string }[]).find(
      (r) => r.id === id,
    )?.when ?? null;
  return [
    {
      id: "small",
      tier: "auto",
      when: when("small"),
      text: `Agent refunds up to ${usd(s.agentAutoLimitMinor)} are allowed within a budget of ${usd(s.budgetMaxMinor)} and ${s.budgetMaxCount} refunds per 24 hours.`,
    },
    {
      id: "human-step-up",
      tier: "step_up",
      when: when("human-step-up"),
      text: `A human with fresh MFA (5 minutes) may refund up to ${usd(s.highValueAboveMinor)} directly.`,
    },
    {
      id: "high-value",
      tier: "high_value",
      when: when("high-value"),
      text: `Over ${usd(s.highValueAboveMinor)} needs ${quorum === 2 ? "two different reviewers" : "a reviewer"} approving this exact operation with a fresh WebAuthn confirmation.`,
    },
    {
      id: "default",
      tier: "routine",
      when: null,
      text:
        s.allowAuthenticatorApp === true
          ? "Anything else needs one other reviewer approving this exact operation with a fresh passkey, security key or authenticator-app code (demo setting: authenticator apps allowed)."
          : "Anything else needs one other reviewer approving this exact operation with a fresh WebAuthn confirmation.",
    },
    {
      id: "unknown",
      tier: "deny",
      when: null,
      text: "Any action the policy does not name is denied.",
    },
  ];
}
