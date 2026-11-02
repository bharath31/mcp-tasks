"use strict";
// Dedicated email-OTP approval clients use WebAuthn as a fresh second factor.
// The next Action stamps the proof only after this challenge has completed.
const CLIENT_ID = "__APPROVAL_CLIENT_ID__"; // init substitutes this public app id.
exports.onExecutePostLogin = async (event, api) => {
  if (
    event.client?.client_id !== CLIENT_ID ||
    event.client?.metadata?.task_authority_approval !== "webauthn-mfa"
  )
    return;
  if (event.agent || event.user.email_verified !== true) {
    api.access.deny("A person with a verified email has to approve.");
    return;
  }
  if (
    !api.authentication?.challengeWith ||
    !api.authentication?.enrollWithAny ||
    !api.multifactor?.enable
  ) {
    api.access.deny(
      "Enable Customize MFA Factors using Actions for approvals.",
    );
    return;
  }
  const factors = (event.client.metadata.approval_mfa_factors || "")
    .split(",")
    .filter((type) => ["webauthn-platform", "webauthn-roaming"].includes(type));
  if (!factors.length) {
    api.access.deny("Configure a WebAuthn factor for approval sign-ins.");
    return;
  }
  api.multifactor.enable("any", { allowRememberBrowser: false });
  const enrolled = factors.filter((type) =>
    (event.user.enrolledFactors || []).some((factor) => factor.type === type),
  );
  if (!enrolled.length) {
    api.authentication.enrollWithAny(factors.map((type) => ({ type })));
  } else {
    api.authentication.challengeWith(
      { type: enrolled[0] },
      { additionalFactors: enrolled.slice(1).map((type) => ({ type })) },
    );
  }
};
