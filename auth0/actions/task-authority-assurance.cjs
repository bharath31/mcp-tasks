"use strict";
// Runs after task-authority-approval.cjs. Preserve the actual MFA timestamp.
const NS = "https://task-authority.example/";
exports.onExecutePostLogin = async (event, api) => {
  if (
    event.resource_server?.identifier !== event.secrets.TASK_AUTHORITY_AUDIENCE
  )
    return;
  const details = event.transaction?.requested_authorization_details || [];
  const wanted =
    details.some((d) => d?.type === "task_authority_approval") ||
    (event.transaction?.requested_scopes || []).includes("approvals:decide");
  const challenge = event.request?.query?.task_authority_challenge;
  if (!wanted && !challenge) return;
  const methods = (event.authentication?.methods || []).filter(
    (m) =>
      m.name === "mfa" &&
      Number.isFinite(Date.parse(m.timestamp)) &&
      Date.parse(m.timestamp) <= Date.now() + 5000,
  );
  const at = Math.max(...methods.map((m) => Date.parse(m.timestamp)));
  if (
    !Number.isFinite(at) ||
    at > Date.now() + 5000 ||
    Date.now() - at > 3600000
  ) {
    api.access.deny("A fresh second factor is required to approve.");
    return;
  }
  // The factor that completed the freshest MFA lets the service enforce a tier's `factors`
  // list. Auth0 reports a second factor as { name: "mfa", type: "<factor>" }; `name` is the
  // primary method ("email", "pwd"), which says nothing about the second factor. Only the
  // factor used at `at` counts, so an older passkey cannot dress up a fresh OTP step-up.
  const factors = methods
    .filter((m) => Date.parse(m.timestamp) === at)
    .map((m) => m.type)
    .filter(
      (t) =>
        typeof t === "string" &&
        /^(webauthn-platform|webauthn-roaming|otp|push-notification|phone|email|recovery-code)$/.test(
          t,
        ),
    );
  api.accessToken.setCustomClaim(`${NS}amr`, ["mfa", ...new Set(factors)]);
  api.accessToken.setCustomClaim(
    `${NS}decision_jti`,
    require("node:crypto").randomUUID(),
  );
  if (typeof challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(challenge))
    api.accessToken.setCustomClaim(`${NS}approval_challenge`, challenge);
  api.accessToken.setCustomClaim(`${NS}auth_time`, Math.floor(at / 1000));
};
