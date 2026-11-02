// Read-only check that an Auth0 tenant has everything Policy Desk needs, so setup can end with a
// plain "Auth0 is fully set up" (or say exactly what is missing). It only issues GETs.
//
// Used by `npm run setup` (last step) and `npm run setup -- --verify`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, ORG_NAME, REPO_ROOT, SPA_NAME } from "./provision.mjs";
import { TEXT, mergeText } from "./ul-text.mjs";

export const EMAIL_CONNECTION = "email";
export const MFA_FACTORS = ["webauthn-roaming", "webauthn-platform", "otp"];

const enc = encodeURIComponent;
const arr = (v, key) => (Array.isArray(v) ? v : (v?.[key] ?? []));

/**
 * Runs every check and returns [{ ok, label, detail?, fix? }]. `api(method, path)` is the setup
 * script's Auth0 CLI wrapper; a failing GET becomes a failed check, never an exception.
 */
export async function verifyAuth0(
  api,
  state,
  { origin, connection = "Username-Password-Authentication", mfa = true },
  { readFile = (p) => readFileSync(p, "utf8") } = {},
) {
  const checks = [];
  const RERUN = "Re-run `npm run setup`.";
  const check = async (label, fn, fix = RERUN) => {
    try {
      const r = await fn();
      const ok = r === true || r?.ok === true;
      checks.push({
        ok,
        label,
        detail: typeof r === "object" ? r.detail : undefined,
        ...(ok ? {} : { fix: r?.fix ?? fix }),
      });
    } catch (e) {
      checks.push({
        ok: false,
        label,
        detail: String(e?.message ?? e).slice(0, 200),
        fix,
      });
    }
  };
  const get = (path) => api("GET", path);
  const audience = `${origin}/task-authority`;

  await check("Task Authority API", async () => {
    const rs = await get(`resource-servers/${enc(audience)}`);
    return { ok: rs?.identifier === audience, detail: audience };
  });

  const spaId = state.clients?.spa?.client_id;
  await check(`"${SPA_NAME}" app with this origin's callbacks`, async () => {
    const c = await get(`clients/${enc(spaId)}`);
    const missing = [`${origin}/`, `${origin}/review`].filter(
      (u) => !(c?.callbacks ?? []).includes(u),
    );
    if (missing.length)
      return { ok: false, detail: `callbacks lack ${missing.join(", ")}` };
    if (c?.name !== SPA_NAME)
      return { ok: false, detail: `named "${c?.name}", not "${SPA_NAME}"` };
    return { ok: true, detail: spaId };
  });

  const others = Object.entries(state.clients ?? {}).filter(
    ([k]) => k !== "spa",
  );
  await check(`${others.length} machine and agent clients`, async () => {
    const gone = [];
    for (const [key, { client_id }] of others) {
      const c = await get(`clients/${enc(client_id)}`).catch(() => null);
      if (!c?.client_id) gone.push(key);
    }
    return gone.length
      ? { ok: false, detail: `missing: ${gone.join(", ")}` }
      : { ok: others.length >= 7, detail: others.map(([k]) => k).join(", ") };
  });

  const orgId = state.organization?.id;
  let emailConn;
  await check(`Organization "${ORG_NAME}"`, async () => {
    const org = await get(`organizations/${enc(orgId)}`);
    return { ok: org?.name === ORG_NAME, detail: orgId };
  });

  await check(
    `Passwordless "${EMAIL_CONNECTION}" sign-in for the app and organization`,
    async () => {
      emailConn = arr(
        await get(
          `connections?name=${EMAIL_CONNECTION}&fields=id,name,strategy&include_fields=true`,
        ),
        "connections",
      ).find((c) => c.name === EMAIL_CONNECTION);
      if (!emailConn) return { ok: false, detail: "connection not found" };
      if (!(await connectionHasClient(get, emailConn.id, spaId)))
        return { ok: false, detail: `not enabled for ${SPA_NAME}` };
      const onOrg = arr(
        await get(`organizations/${enc(orgId)}/enabled_connections`),
        "enabled_connections",
      ).some((c) => c.connection_id === emailConn.id);
      return onOrg
        ? { ok: true, detail: "email one-time code" }
        : { ok: false, detail: "not enabled on the organization" };
    },
  );

  await check(`Delegating user (Alex) in "${connection}"`, async () => {
    const id = state.alex?.user_id;
    if (!id) return { ok: false, detail: "no user in the state file" };
    const u = await get(`users/${enc(id)}`);
    return { ok: u?.user_id === id, detail: state.alex.email };
  });

  if (mfa)
    await check(
      "MFA factors: passkeys, security keys, authenticator app",
      async () => {
        const factors = arr(await get("guardian/factors"), "factors");
        const off = MFA_FACTORS.filter(
          (n) => !factors.find((f) => f.name === n)?.enabled,
        );
        return off.length
          ? { ok: false, detail: `not enabled: ${off.join(", ")}` }
          : { ok: true, detail: MFA_FACTORS.join(", ") };
      },
      "Re-run `npm run setup` without --no-mfa.",
    );

  await check("Post-login Actions deployed with this repo's code", async () => {
    const stale = [];
    for (const spec of ACTIONS) {
      const id = state.actions?.[spec.key]?.id;
      const a = id ? await get(`actions/actions/${enc(id)}`) : null;
      const code = readFile(join(REPO_ROOT, spec.file));
      if (!a || a.code !== code || a.all_changes_deployed !== true)
        stale.push(spec.name);
    }
    return stale.length
      ? { ok: false, detail: `out of date: ${stale.join(", ")}` }
      : { ok: true, detail: ACTIONS.map((a) => a.name).join(", ") };
  });

  await check("Actions bound to the login flow, in order", async () => {
    const names = arr(
      await get("actions/triggers/post-login/bindings"),
      "bindings",
    ).map((b) => b.action?.name ?? b.display_name);
    const at = ACTIONS.map((a) => names.indexOf(a.name));
    if (at.some((i) => i < 0)) return { ok: false, detail: "not bound" };
    return at.every((v, i) => i === 0 || v > at[i - 1])
      ? { ok: true, detail: `${names.length} Action(s) in the flow` }
      : {
          ok: false,
          detail: "bound in the wrong order",
          fix: "Fix the order under Actions > Triggers > post-login.",
        };
  });

  await check("Universal Login text for sign-in and approvals", async () => {
    const stale = [];
    for (const [prompt, screens] of Object.entries(TEXT))
      if (mergeText(await get(`prompts/${prompt}/custom-text/en`), screens))
        stale.push(prompt);
    return stale.length
      ? { ok: false, detail: `not applied: ${stale.join(", ")}` }
      : { ok: true, detail: `${Object.keys(TEXT).length} prompts` };
  });

  return checks;
}

async function connectionHasClient(get, connectionId, clientId) {
  const full = await get(`connections/${enc(connectionId)}`);
  if (Array.isArray(full?.enabled_clients))
    return full.enabled_clients.includes(clientId);
  const list = arr(
    await get(`connections/${enc(connectionId)}/clients`),
    "clients",
  );
  return list.some((c) => c.client_id === clientId);
}

/** One check as a checklist line, with its fix underneath when it failed. */
export function formatCheck(c) {
  return `  ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? `  (${c.detail})` : ""}${c.ok ? "" : `\n      Fix: ${c.fix}`}`;
}

/** Prints the checklist and the verdict; returns true when every check passed. */
export function report(checks, say, { tenant, after = [] }) {
  for (const c of [...checks, ...after]) say(formatCheck(c));
  const bad = checks.filter((c) => !c.ok).length;
  say(
    bad
      ? `\n✗ Auth0 is not fully set up on ${tenant}: ${bad} of ${checks.length} checks failed.`
      : `\n✓ Auth0 is fully set up on ${tenant} (${checks.length} of ${checks.length} checks passed).`,
  );
  return bad === 0;
}
