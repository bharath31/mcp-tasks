import assert from "node:assert/strict";
import { test } from "node:test";
import { stepUpParams, tokenRequest } from "../web/src/auth.js";

const SIGN_IN = "openid profile email approvals:read";

test("a refund step-up keeps the email sign-in and asks for the decide scope", () => {
  const p = stepUpParams({ max_age: null }, SIGN_IN, {
    task_authority_challenge: "c",
    task_authority_factor: "webauthn",
  });
  // No max_age: Auth0 does not ask for the email code again; the Action forces the passkey.
  assert.equal("max_age" in p, false);
  assert.equal(p.scope, `${SIGN_IN} approvals:decide`);
  assert.equal(p.task_authority_factor, "webauthn");
});

test("a routine step-up still forces re-authentication by default", () => {
  assert.equal(stepUpParams({}, SIGN_IN).max_age, 0);
  assert.equal(stepUpParams({ max_age: 300 }, SIGN_IN).max_age, 300);
});

test("the replay after a step-up sends the step-up token, never the sign-in token", () => {
  // The sign-in token is cached under the sign-in scope; asking for that scope would
  // send it, and the service refuses it with mfa_required.
  assert.deepEqual(tokenRequest(true, SIGN_IN, "aud"), {
    authorizationParams: {
      audience: "aud",
      scope: `${SIGN_IN} approvals:decide`,
    },
    cacheMode: "cache-only",
  });
  assert.deepEqual(tokenRequest(false, SIGN_IN, "aud"), {
    authorizationParams: { audience: "aud" },
  });
});
