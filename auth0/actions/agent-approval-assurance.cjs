"use strict";
// Runs after agent-approval-mfa. Client metadata survives the MFA boundary;
// event.request.query may not. Never stamp assurance before the challenge.
const NS = "https://task-authority.example/";
const CLIENT_ID = "__APPROVAL_CLIENT_ID__"; // init substitutes this public app id.
exports.onExecutePostLogin = async (event, api) => {
  if (
    event.client?.client_id !== CLIENT_ID ||
    event.client?.metadata?.task_authority_approval !== "webauthn-mfa"
  )
    return;
  const now = Date.now();
  const methods = (event.authentication?.methods || []).filter(
    (method) =>
      method.name === "mfa" &&
      Number.isFinite(Date.parse(method.timestamp)) &&
      Date.parse(method.timestamp) <= now + 5000,
  );
  const at = Math.max(...methods.map((method) => Date.parse(method.timestamp)));
  const factor = methods.find(
    (method) => Date.parse(method.timestamp) === at,
  )?.type;
  if (
    !Number.isFinite(at) ||
    at > now + 5000 ||
    now - at > 5 * 60 * 1000 ||
    !["webauthn-platform", "webauthn-roaming"].includes(factor)
  ) {
    api.access.deny("A fresh passkey or security key is required to approve.");
    return;
  }
  api.idToken.setCustomClaim(`${NS}approval`, {
    method: "passkey",
    factor,
    at: Math.floor(at / 1000),
    roles: (event.authorization?.roles || []).filter(
      (role) => typeof role === "string",
    ),
  });
};
