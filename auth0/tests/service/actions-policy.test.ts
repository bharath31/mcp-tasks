import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const approval = require("../../actions/task-authority-approval.cjs");
const assurance = require("../../actions/task-authority-assurance.cjs");
const details = [
  {
    type: "task_authority_approval",
    approval_id: "apr1",
    operation_digest: "sha256:abc",
  },
];
test("approval Action reads documented transaction details and defaults to WebAuthn without push", async () => {
  let challenge: any;
  let remembered: unknown;
  await approval.onExecutePostLogin(
    {
      transaction: { requested_authorization_details: details },
      user: {
        email_verified: true,
        enrolledFactors: [
          { type: "otp" },
          { type: "webauthn-platform" },
          { type: "webauthn-roaming" },
          { type: "push-notification" },
        ],
      },
      authentication: { methods: [] },
    },
    {
      authentication: {
        challengeWith: (factor: any, options: any) => {
          challenge = { factor, options };
        },
      },
      access: { deny: assert.fail },
      multifactor: {
        enable: (provider: string, options: unknown) => {
          remembered = { provider, options };
        },
      },
    },
  );
  assert.equal(challenge.factor.type, "webauthn-platform");
  assert.deepEqual(remembered, {
    provider: "any",
    options: { allowRememberBrowser: false },
  });
  assert.deepEqual(challenge.options.additionalFactors, [
    { type: "webauthn-roaming" },
    { type: "otp" },
  ]);
});
test("assurance Action preserves the actual MFA time and rejects stale sessions", async () => {
  const claims: Record<string, unknown> = {};
  const at = Date.now() - 60000;
  const event = {
    resource_server: { identifier: "api" },
    secrets: { TASK_AUTHORITY_AUDIENCE: "api" },
    transaction: { requested_authorization_details: details },
    authentication: {
      methods: [{ name: "mfa", timestamp: new Date(at).toISOString() }],
    },
  };
  const api = {
    accessToken: {
      setCustomClaim: (k: string, v: unknown) => {
        claims[k] = v;
      },
    },
    access: { deny: assert.fail },
  };
  await assurance.onExecutePostLogin(event, api);
  assert.equal(
    claims["https://task-authority.example/auth_time"],
    Math.floor(at / 1000),
  );
  let denied = false;
  await assurance.onExecutePostLogin(
    {
      ...event,
      authentication: {
        methods: [
          {
            name: "mfa",
            timestamp: new Date(Date.now() - 7200000).toISOString(),
          },
        ],
      },
    },
    {
      ...api,
      access: {
        deny: () => {
          denied = true;
        },
      },
    },
  );
  assert.equal(denied, true);
});
test("assurance Action names the factor that completed the freshest MFA, read from its type", async () => {
  const run = async (methods: Array<Record<string, unknown>>) => {
    const claims: Record<string, unknown> = {};
    await assurance.onExecutePostLogin(
      {
        resource_server: { identifier: "api" },
        secrets: { TASK_AUTHORITY_AUDIENCE: "api" },
        transaction: { requested_scopes: ["approvals:decide"] },
        authentication: { methods },
      },
      {
        accessToken: {
          setCustomClaim: (k: string, v: unknown) => {
            claims[k] = v;
          },
        },
        access: { deny: assert.fail },
      },
    );
    return claims["https://task-authority.example/amr"];
  };
  const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
  // Auth0 reports a passkey second factor as name "mfa" with the factor in `type`; the primary
  // passwordless login ("email") is not a second factor.
  assert.deepEqual(
    await run([
      { name: "email", timestamp: iso(120000) },
      { name: "mfa", type: "webauthn-platform", timestamp: iso(60000) },
    ]),
    ["mfa", "webauthn-platform"],
  );
  // A passkey 50 minutes ago does not vouch for a fresh OTP step-up.
  assert.deepEqual(
    await run([
      { name: "mfa", type: "webauthn-roaming", timestamp: iso(3000000) },
      { name: "mfa", type: "otp", timestamp: iso(30000) },
    ]),
    ["mfa", "otp"],
  );
  // The enrolment flow: the Guardian code Auth0 demands first, then the new passkey.
  // Only the passkey, the later of the two, reaches the token.
  assert.deepEqual(
    await run([
      { name: "email", timestamp: iso(90000) },
      { name: "mfa", type: "otp", timestamp: iso(40000) },
      { name: "mfa", type: "webauthn-platform", timestamp: iso(10000) },
    ]),
    ["mfa", "webauthn-platform"],
  );
});
test("approval Action runs no MFA at a plain email OTP sign-in", async () => {
  await approval.onExecutePostLogin(
    {
      transaction: { requested_scopes: ["openid", "approvals:read"] },
      user: { email_verified: true, enrolledFactors: [{ type: "otp" }] },
      authentication: {
        methods: [{ name: "email", timestamp: new Date().toISOString() }],
      },
    },
    {
      authentication: {
        challengeWith: assert.fail,
        enrollWithAny: assert.fail,
      },
      access: { deny: assert.fail },
      multifactor: { enable: assert.fail },
    },
  );
});
// The refund step-up matrix (docs/approval-step-up-flows.md): every enrolled-factor
// combination ends on a passkey challenge or a passkey enrolment, never on an OTP alone.
const runStepUp = async (
  enrolledFactors: { type: string }[],
  over: Record<string, unknown> = {},
  factor = "webauthn",
) => {
  const seen: {
    challenge?: string[];
    challengeAny?: string[];
    enroll?: string[];
    multifactor?: boolean;
    denied?: string;
  } = {};
  await approval.onExecutePostLogin(
    {
      request: {
        query: {
          task_authority_challenge: "c".repeat(43),
          task_authority_factor: factor,
        },
      },
      transaction: { requested_scopes: ["approvals:decide"] },
      user: { email_verified: true, enrolledFactors },
      authentication: { methods: [] },
      ...over,
    },
    {
      authentication: {
        challengeWith: (factor: any, options: any) => {
          seen.challenge = [factor, ...(options?.additionalFactors ?? [])].map(
            (f: { type: string }) => f.type,
          );
        },
        challengeWithAny: (factors: { type: string }[]) => {
          seen.challengeAny = factors.map((f) => f.type);
        },
        enrollWithAny: (factors: { type: string }[]) => {
          seen.enroll = factors.map((f) => f.type);
        },
      },
      access: {
        deny: (reason: string) => {
          seen.denied = reason;
        },
      },
      // The classic MFA prompt would run its own challenge alongside ours.
      multifactor: {
        enable: () => {
          seen.multifactor = true;
        },
      },
    },
  );
  return seen;
};
const PASSKEYS = ["webauthn-platform", "webauthn-roaming"];
test("refund step-up: a reviewer with a passkey is asked for that passkey only", async () => {
  assert.deepEqual(
    await runStepUp([{ type: "otp" }, { type: "webauthn-platform" }]),
    { challenge: ["webauthn-platform"] },
  );
  assert.deepEqual(await runStepUp([{ type: "webauthn-roaming" }]), {
    challenge: ["webauthn-roaming"],
  });
  assert.deepEqual(
    await runStepUp([
      { type: "webauthn-roaming" },
      { type: "webauthn-platform" },
      { type: "push-notification" },
    ]),
    { challenge: PASSKEYS },
  );
});
test("refund step-up: a reviewer with no passkey enrols one, after one challenge Auth0 requires", async () => {
  // No factor at all: straight to passkey enrolment, no code.
  assert.deepEqual(await runStepUp([]), { enroll: PASSKEYS });
  // Auth0 lists email for verified users; it is not a factor to challenge first.
  assert.deepEqual(await runStepUp([{ type: "email" }]), { enroll: PASSKEYS });
  // Guardian OTP, push or SMS: proved once (Auth0 only adds a factor after that), then
  // a passkey is enrolled. The code alone never ends the step-up.
  assert.deepEqual(await runStepUp([{ type: "otp" }]), {
    challengeAny: ["otp"],
    enroll: PASSKEYS,
  });
  assert.deepEqual(
    await runStepUp([{ type: "push-notification" }, { type: "otp" }]),
    { challengeAny: ["otp", "push-notification"], enroll: PASSKEYS },
  );
  assert.deepEqual(await runStepUp([{ type: "phone" }]), {
    challengeAny: ["phone"],
    enroll: PASSKEYS,
  });
  // A recovery code is not something to prove before enrolling.
  assert.deepEqual(await runStepUp([{ type: "recovery-code" }]), {
    enroll: PASSKEYS,
  });
});
test("refund step-up: agents and unverified emails are refused before any factor", async () => {
  assert.equal(
    (await runStepUp([], { agent: { id: "x" } })).denied,
    "A human reviewer is required.",
  );
  const unverified = await runStepUp([{ type: "webauthn-platform" }], {
    user: { email_verified: false, enrolledFactors: [] },
  });
  assert.match(unverified.denied ?? "", /Verify your email/);
  assert.equal(unverified.challenge, undefined);
});
test("refund step-up: a recent sign-in MFA does not skip the per-operation passkey", async () => {
  const seen = await runStepUp([{ type: "webauthn-platform" }], {
    authentication: {
      methods: [
        { name: "mfa", type: "otp", timestamp: new Date().toISOString() },
      ],
    },
  });
  assert.deepEqual(seen, { challenge: ["webauthn-platform"] });
});
test("refund step-up: a tier that accepts an authenticator app offers it, never the classic prompt", async () => {
  const OR_APP = [...PASSKEYS, "otp"];
  // Nothing enrolled: the reviewer picks a passkey or an authenticator app to enrol.
  assert.deepEqual(await runStepUp([], {}, "webauthn_or_otp"), {
    enroll: OR_APP,
  });
  // An authenticator app already enrolled: one fresh code, no passkey enrolment.
  assert.deepEqual(await runStepUp([{ type: "otp" }], {}, "webauthn_or_otp"), {
    challenge: ["otp"],
  });
  // A passkey stays first when both are enrolled; the app code is the alternative.
  assert.deepEqual(
    await runStepUp(
      [{ type: "otp" }, { type: "webauthn-platform" }],
      {},
      "webauthn_or_otp",
    ),
    { challenge: ["webauthn-platform", "otp"] },
  );
  // Push only: proved once, then a passkey or an app is enrolled.
  assert.deepEqual(
    await runStepUp([{ type: "push-notification" }], {}, "webauthn_or_otp"),
    { challengeAny: ["push-notification"], enroll: OR_APP },
  );
});
