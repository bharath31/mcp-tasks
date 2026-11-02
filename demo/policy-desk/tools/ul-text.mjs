#!/usr/bin/env node
// Universal Login copy for the refund approval step-up: tells a reviewer what each Auth0 screen
// is for, so a Guardian code that Auth0 asks for before passkey enrolment does not look like the
// approval itself. Uses the Auth0 CLI's `auth0 api` like provision.mjs.
//
//   node demo/policy-desk/tools/ul-text.mjs --tenant <tenant>.us.auth0.com [--apply]
//
// Default is a dry run: it reads the current custom text and prints what would change. --apply
// merges these keys into each prompt's existing English custom text (other keys are kept; Auth0's
// PUT replaces a prompt's whole text, so the merge happens here). Custom text is tenant-wide, so
// the copy reads correctly for any app on the tenant, not only Policy Desk.
import { pathToFileURL } from "node:url";
import { parseCliJson, realRunner } from "./provision.mjs";

const PASSKEY_WHY =
  "Refund approvals in Policy Desk need a passkey or security key.";

export const TEXT = {
  "mfa-otp": {
    "mfa-otp-challenge": {
      title: "Enter your authenticator code",
      description:
        "Open your authenticator app (such as Google Authenticator or Auth0 Guardian) and enter its 6-digit code. If your Policy Desk sandbox accepts authenticator apps for routine refunds, this code confirms the one refund you are approving. Otherwise Auth0 asks for it once so you can add a passkey next, and the code alone never approves a refund.",
    },
    "mfa-otp-enrollment-qr": {
      title: "Add an authenticator app",
      description:
        "Scan this code with an authenticator app (such as Google Authenticator, 1Password or Auth0 Guardian), then enter the 6-digit code it shows. Policy Desk asks for a fresh code from this app each time you approve a routine refund.",
    },
  },
  // Sign-in and sign-up: name the app (${clientName}), not the tenant, and say what the code is for.
  "login-id": {
    "login-id": {
      title: "Sign in to ${clientName}",
      description:
        "Enter your email. We'll send you a one-time code: no password. A new email creates your account.",
      logoAltText: "${clientName}",
    },
  },
  "login-passwordless": {
    "login-passwordless-email-code": {
      title: "Check your email",
      description:
        "We sent a 6-digit code to ${email}. Enter it to continue to ${clientName}. The code expires in a few minutes; ask for a new one only if it has not arrived.",
      logoAltText: "${clientName}",
    },
  },
  "signup-id": {
    "signup-id": {
      title: "Create your ${clientName} account",
      description:
        "Enter your email. We'll send you a one-time code: no password.",
      logoAltText: "${clientName}",
    },
  },
  "mfa-push": {
    "mfa-push-challenge-push": {
      title: "Approve the Guardian notification",
      description:
        "We sent a notification to Auth0 Guardian on your phone. If you are approving a refund and have no passkey yet, Auth0 asks for this once so you can add a passkey on the next screen. It never approves a refund by itself.",
    },
  },
  "mfa-sms": {
    "mfa-sms-challenge": {
      title: "Enter the code we texted you",
      description:
        "If you are approving a refund and have no passkey yet, Auth0 asks for this code once so you can add a passkey on the next screen. The code alone never approves a refund.",
    },
  },
  "mfa-webauthn": {
    "mfa-webauthn-platform-enrollment": {
      title: "Create a passkey",
      description: `${PASSKEY_WHY} Create one with Face ID, Touch ID, Windows Hello or your device PIN. You will use it for this approval and every one after it.`,
    },
    "mfa-webauthn-roaming-enrollment": {
      title: "Add a security key",
      description: `${PASSKEY_WHY} Insert or tap your security key to register it. You will use it for this approval and every one after it.`,
    },
    "mfa-webauthn-platform-challenge": {
      title: "Confirm with your passkey",
      description: `${PASSKEY_WHY} Confirm with Face ID, Touch ID, Windows Hello or your device PIN. This check is tied to the one refund you are approving.`,
    },
    "mfa-webauthn-roaming-challenge": {
      title: "Confirm with your security key",
      description: `${PASSKEY_WHY} Insert or tap your security key. This check is tied to the one refund you are approving.`,
    },
  },
};

/** Our keys over the tenant's current text, screen by screen. Returns null when nothing changes. */
export function mergeText(current, ours) {
  const next = structuredClone(
    current && typeof current === "object" ? current : {},
  );
  let changed = false;
  for (const [screen, keys] of Object.entries(ours)) {
    next[screen] = { ...(next[screen] ?? {}) };
    for (const [k, v] of Object.entries(keys)) {
      if (next[screen][k] !== v) {
        next[screen][k] = v;
        changed = true;
      }
    }
  }
  return changed ? next : null;
}

/**
 * Merges TEXT into each prompt's English custom text. `api(method, path, body)` is an Auth0 CLI
 * wrapper (setup.mjs passes its own). Returns the prompts it wrote (or would write).
 */
export async function applyUlText(
  api,
  { apply = false, say = console.log } = {},
) {
  const changed = [];
  for (const [prompt, screens] of Object.entries(TEXT)) {
    const path = `prompts/${prompt}/custom-text/en`;
    const next = mergeText(await api("get", path), screens);
    if (!next) {
      say(`SKIP  Universal Login text for ${prompt} already set`);
      continue;
    }
    say(
      `${apply ? "PUT " : "PLAN"}  ${path}: ${Object.keys(screens).join(", ")}`,
    );
    if (apply) await api("put", path, next);
    changed.push(prompt);
  }
  return changed;
}

export async function main(
  argv,
  { run = realRunner(), say = console.log } = {},
) {
  const ti = argv.indexOf("--tenant");
  const tenant = ti >= 0 ? argv[ti + 1] : undefined;
  const apply = argv.includes("--apply");
  if (!tenant) {
    say(
      "Usage: node demo/policy-desk/tools/ul-text.mjs --tenant <domain> [--apply]",
    );
    return 2;
  }
  const api = async (method, path, body) => {
    const args = ["api", method, path, "--tenant", tenant, "--no-input"];
    const r = await run(
      body === undefined ? args : [...args, "--data", JSON.stringify(body)],
    );
    if (r.code !== 0)
      throw new Error(`auth0 api ${method} ${path} failed: ${r.stderr.trim()}`);
    return parseCliJson(r.stdout);
  };
  await applyUlText(api, { apply, say });
  if (!apply) say("Dry run. Re-run with --apply to write.");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e?.message ?? e));
      process.exit(1);
    },
  );
