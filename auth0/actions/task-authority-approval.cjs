"use strict";
// Auth0 Actions v3. RAR details must arrive through PAR, not a front-channel query.
const TYPE = "task_authority_approval";
const WEBAUTHN = ["webauthn-platform", "webauthn-roaming"];
// Factors Auth0 can challenge before it lets the user enrol a new one. Not "email":
// Auth0 lists it for every verified user, and challengeWithAny fails the login when
// none of its factors is enabled on the tenant.
const CHALLENGEABLE = ["otp", "push-notification", "phone"];
exports.onExecutePostLogin = async (event, api) => {
  const details = event.transaction?.requested_authorization_details || [];
  const transaction =
    details.some((d) => d && d.type === TYPE) ||
    Boolean(event.request?.query?.task_authority_challenge);
  const session = (event.transaction?.requested_scopes || []).includes(
    "approvals:decide",
  );
  if (!transaction && !session) return;
  if (event.agent) {
    api.access.deny("A human reviewer is required.");
    return;
  }
  if (event.user.email_verified !== true) {
    api.access.deny("Verify your email before approving.");
    return;
  }
  const methods = event.authentication?.methods || [];
  const now = Date.now();
  const recentMfa = methods.some(
    (m) =>
      m.name === "mfa" &&
      Number.isFinite(Date.parse(m.timestamp)) &&
      Date.parse(m.timestamp) <= now + 5000 &&
      now - Date.parse(m.timestamp) <= 3600000,
  );
  if (session && !transaction && recentMfa) return;
  // A per-operation decision says which factors its tier accepts, so the reviewer is
  // not offered one the service would refuse. "webauthn": passkeys only (the default).
  // "webauthn_or_otp": a tier that also accepts an authenticator-app code (a demo
  // opt-in for reviewers with no passkey device). It can only narrow the choice; the
  // service still checks the factor in the token against the tier.
  const factor = transaction ? event.request?.query?.task_authority_factor : "";
  const accepted =
    factor === "webauthn"
      ? WEBAUTHN
      : factor === "webauthn_or_otp"
        ? [...WEBAUTHN, "otp"]
        : null;
  const has = (type) =>
    (event.user.enrolledFactors || []).some((f) => f.type === type);
  if (accepted) {
    const enrolled = accepted.filter(has);
    if (enrolled.length) {
      api.authentication.challengeWith(
        { type: enrolled[0] },
        { additionalFactors: enrolled.slice(1).map((type) => ({ type })) },
      );
    } else {
      // Nothing accepted is enrolled yet: enrol one. Auth0 adds a factor only after a
      // challenge with one the user already has, so a reviewer with push or SMS (or an
      // authenticator app, when only passkeys are accepted) proves it once first; the
      // factor enrolled next is the one that counts.
      // Without the challenge Auth0 shows "contact your system administrator".
      const existing = CHALLENGEABLE.filter(has);
      if (existing.length)
        api.authentication.challengeWithAny(existing.map((type) => ({ type })));
      api.authentication.enrollWithAny(accepted.map((type) => ({ type })));
    }
  } else {
    // Remembered devices must not skip a challenge whose result we attest below.
    api.multifactor.enable("any", { allowRememberBrowser: false });
    const supported = [...WEBAUTHN, "otp"];
    const enrolled = supported.filter(has);
    if (!enrolled.length) {
      const existing = CHALLENGEABLE.filter(has);
      if (existing.length)
        api.authentication.challengeWithAny(existing.map((type) => ({ type })));
      api.authentication.enrollWithAny(supported.map((type) => ({ type })));
    } else {
      api.authentication.challengeWith(
        { type: enrolled[0] },
        {
          additionalFactors: enrolled.slice(1).map((type) => ({ type })),
        },
      );
    }
  }
  if (event.session && api.session) {
    api.session.setExpiresAt(Date.now() + 3600000);
    api.session.setIdleExpiresAt(Date.now() + 900000);
  }
};
