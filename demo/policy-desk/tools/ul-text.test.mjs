import assert from "node:assert/strict";
import { test } from "node:test";
import { TEXT, main, mergeText } from "./ul-text.mjs";

test("mergeText keeps the tenant's other keys and reports no-ops", () => {
  const current = {
    "mfa-otp-challenge": { buttonText: "Go", title: "Old" },
    "mfa-otp-enrollment-code": { title: "Scan" },
  };
  const next = mergeText(current, TEXT["mfa-otp"]);
  assert.equal(next["mfa-otp-challenge"].buttonText, "Go");
  assert.equal(next["mfa-otp-enrollment-code"].title, "Scan");
  assert.match(next["mfa-otp-challenge"].description, /Guardian/);
  assert.equal(current["mfa-otp-challenge"].title, "Old");
  assert.equal(mergeText(next, TEXT["mfa-otp"]), null);
});

test("the Guardian code screens say why the code is asked and that it approves nothing", () => {
  for (const [prompt, screen] of [
    ["mfa-otp", "mfa-otp-challenge"],
    ["mfa-push", "mfa-push-challenge-push"],
    ["mfa-sms", "mfa-sms-challenge"],
  ]) {
    const d = TEXT[prompt][screen].description;
    assert.match(d, /passkey/);
    assert.match(d, /never approves a refund/);
  }
});

test("dry run only reads; --apply merges and writes each changed prompt", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return { code: 0, stdout: args[1] === "get" ? "{}" : "{}", stderr: "" };
  };
  const out = [];
  assert.equal(
    await main(["--tenant", "t.auth0.com"], { run, say: (l) => out.push(l) }),
    0,
  );
  assert.ok(calls.every((a) => a[1] === "get"));
  assert.equal(calls.length, Object.keys(TEXT).length);
  calls.length = 0;
  await main(["--tenant", "t.auth0.com", "--apply"], { run, say: () => {} });
  const puts = calls.filter((a) => a[1] === "put");
  assert.equal(puts.length, Object.keys(TEXT).length);
  const body = JSON.parse(puts[0][puts[0].indexOf("--data") + 1]);
  assert.ok(body["mfa-otp-challenge"].title);
});

test("sign-in and sign-up copy names the app, never the tenant", () => {
  for (const prompt of ["login-id", "login-passwordless", "signup-id"])
    for (const keys of Object.values(TEXT[prompt])) {
      const all = Object.values(keys).join(" ");
      assert.doesNotMatch(all, /companyName/);
      assert.match(all, /\$\{clientName\}/);
    }
});
