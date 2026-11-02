"use strict";
// Post-login Action for approve(). Runs only on approval sign-ins, which the SDK marks
// with ?agent_approval=1 (alongside prompt=login and max_age=0). It requires a fresh
// passkey and stamps one claim into the ID token. The SDK refuses any proof without
// that claim, so a sign-in that skips this Action can never count as an approval.
// Auth0 reports a passkey first factor as authentication.methods[].name === "passkey".
const NS = "https://task-authority.example/";
const FRESH_MS = 5 * 60 * 1000;
exports.onExecutePostLogin = async (event, api) => {
  if (event.request?.query?.agent_approval !== "1") return;
  if (event.agent) {
    api.access.deny("A person has to approve this, not an agent.");
    return;
  }
  const now = Date.now();
  const passkey = (event.authentication?.methods || [])
    .filter((m) => m && m.name === "passkey")
    .map((m) => Date.parse(m.timestamp))
    .filter((t) => Number.isFinite(t) && t <= now + 5000 && now - t <= FRESH_MS)
    .sort((a, b) => b - a)[0];
  if (passkey === undefined) {
    api.access.deny(
      "Approvals need a passkey. Sign in with your passkey, or add one to your account first.",
    );
    return;
  }
  api.idToken.setCustomClaim(`${NS}approval`, {
    method: "passkey",
    at: Math.floor(passkey / 1000),
    roles: (event.authorization?.roles || []).filter(
      (r) => typeof r === "string",
    ),
  });
};
