// Idempotent provisioning of a TEST Auth0 tenant for the reference implementation.
// Creates only objects whose names start with "ta-demo"/"TA-DEMO". It never changes tenant-wide
// settings, MFA policies, the universal login, or any existing application, API or user.
//
//   AUTH0_DOMAIN=<tenant>.us.auth0.com AUTH0_MGMT_CLIENT_ID=... AUTH0_MGMT_CLIENT_SECRET=... \
//   OUT=/path/outside/repo/auth0-state.json node auth0/tools/auth0-provision.mjs [--destroy]
//
// The state file holds secrets (client secrets, user passwords, TOTP seeds). Keep it out of git.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const domain = need("AUTH0_DOMAIN");
const out = need("OUT");
const destroy = process.argv.includes("--destroy");
const base = `https://${domain}/api/v2`;
const PREFIX = "ta-demo";
const AUD_AUTHORITY = "https://ta-demo.example/task-authority";
const AUD_MCP = "https://ta-demo.example/refund-desk-mcp";
const APP = "http://127.0.0.1:8787";

const PERMS = {
  api: [
    "delegations:create",
    "delegations:read",
    "delegations:revoke",
    "operations:register",
    "operations:read",
    "operations:cancel",
    "approvals:request",
    "approvals:read",
  ],
  executor: ["operations:read", "claims:create", "outcomes:report"],
  investigator: [
    "usage:read",
    "audit:read",
    "operations:read",
    "delegations:read",
    "approvals:read",
  ],
};
const USERS = [
  ["alice", "northstar"],
  ["morgan", "northstar"],
  ["olivia", "northstar"],
  ["eve", "northstar"],
  ["inspector", "northstar"],
  ["sam", "southridge"],
  ["mallory", "southridge"],
];

const state = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
const save = () =>
  writeFileSync(out, JSON.stringify(state, null, 2), { mode: 0o600 });

let token;
async function auth() {
  const r = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: need("AUTH0_MGMT_CLIENT_ID"),
      client_secret: need("AUTH0_MGMT_CLIENT_SECRET"),
      audience: `${base}/`,
    }),
  });
  token = (await r.json()).access_token;
  if (!token) throw new Error("management token failed");
}
async function api(method, path, body, ok = []) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 429 && attempt < 5) {
      await new Promise((x) => setTimeout(x, 1500 * (attempt + 1)));
      continue;
    }
    const text = await r.text();
    const json = text ? JSON.parse(text) : null;
    if (!r.ok && !ok.includes(r.status))
      throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 400)}`);
    return { status: r.status, json };
  }
}

const base32 = (buf) => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  return (bits.match(/.{1,5}/g) ?? [])
    .map((c) => A[parseInt(c.padEnd(5, "0"), 2)])
    .join("");
};
const secret = () => randomBytes(24).toString("base64url");

await auth();

if (destroy) {
  for (const id of Object.values(state.users ?? {}).map((u) => u.id))
    await api("DELETE", `/users/${encodeURIComponent(id)}`, undefined, [404]);
  for (const o of Object.values(state.orgs ?? {}))
    await api("DELETE", `/organizations/${o}`, undefined, [404]);
  for (const c of Object.values(state.clients ?? {}))
    await api("DELETE", `/clients/${c.client_id}`, undefined, [404]);
  if (state.connectionId)
    await api("DELETE", `/connections/${state.connectionId}`, undefined, [404]);
  for (const id of state.apiIds ?? [])
    await api("DELETE", `/resource-servers/${id}`, undefined, [404]);
  console.log("destroyed");
  process.exit(0);
}

// 1. APIs
state.apiIds ??= [];
async function ensureApi(identifier, name, scopes, extra = {}) {
  const found = await api(
    "GET",
    `/resource-servers/${encodeURIComponent(identifier)}`,
    undefined,
    [404],
  );
  const body = {
    name,
    scopes: scopes.map((value) => ({ value, description: value })),
    signing_alg: "RS256",
    enforce_policies: true,
    token_dialect: "access_token_authz",
    skip_consent_for_verifiable_first_party_clients: true,
    ...extra,
  };
  if (found.status === 200) {
    const { identifier: _i, ...patch } = body;
    await api("PATCH", `/resource-servers/${found.json.id}`, patch);
    return found.json.id;
  }
  const created = await api("POST", `/resource-servers`, {
    identifier,
    ...body,
  });
  state.apiIds.push(created.json.id);
  return created.json.id;
}
const allPerms = [...new Set(Object.values(PERMS).flat())];
await ensureApi(AUD_AUTHORITY, "TA-DEMO Task Authority API", allPerms, {
  authorization_details: [{ type: "task_authority_approval" }],
});
await ensureApi(AUD_MCP, "TA-DEMO Refund Desk MCP", []);
state.audiences = { authority: AUD_AUTHORITY, mcp: AUD_MCP };
save();

// 2. Clients
state.clients ??= {};
async function ensureClient(key, body, grantAudience, scopes) {
  let c = state.clients[key];
  if (!c) {
    const list = await api(
      "GET",
      `/clients?fields=client_id,name&per_page=100&page=0`,
    );
    const hit = list.json.find((x) => x.name === `TA-DEMO ${key}`);
    if (hit) {
      const full = await api(
        "GET",
        `/clients/${hit.client_id}?fields=client_id,client_secret`,
      );
      c = {
        client_id: full.json.client_id,
        client_secret: full.json.client_secret,
      };
    } else {
      const made = await api("POST", "/clients", {
        name: `TA-DEMO ${key}`,
        ...body,
      });
      c = {
        client_id: made.json.client_id,
        client_secret: made.json.client_secret,
      };
    }
    state.clients[key] = c;
    save();
  }
  if (grantAudience) {
    const g = await api(
      "GET",
      `/client-grants?client_id=${c.client_id}&audience=${encodeURIComponent(grantAudience)}`,
    );
    if (g.json.length)
      await api("PATCH", `/client-grants/${g.json[0].id}`, { scope: scopes });
    else
      await api("POST", "/client-grants", {
        client_id: c.client_id,
        audience: grantAudience,
        scope: scopes,
      });
  }
}
const m2m = {
  app_type: "non_interactive",
  grant_types: ["client_credentials"],
};
await ensureClient("api", m2m, AUD_AUTHORITY, PERMS.api);
await ensureClient("executor", m2m, AUD_AUTHORITY, PERMS.executor);
await ensureClient("investigator", m2m, AUD_AUTHORITY, PERMS.investigator);
await ensureClient(
  "mcp-resource",
  {
    app_type: "regular_web",
    grant_types: ["client_credentials"],
  },
  null,
  [],
);
// CIBA backchannel approvals started by the Task Authority service (confidential, first-party).
await ensureClient(
  "ciba",
  {
    app_type: "regular_web",
    is_first_party: true,
    oidc_conformant: true,
    token_endpoint_auth_method: "client_secret_post",
    grant_types: [
      "authorization_code",
      "refresh_token",
      "urn:openid:params:grant-type:ciba",
    ],
    async_approval_notification_channels: ["guardian-push"],
  },
  AUD_AUTHORITY,
  [],
);
const userFlow = {
  oidc_conformant: true,
  organization_usage: "allow",
  organization_require_behavior: "no_prompt",
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
};
await ensureClient(
  "reviewer-spa",
  {
    ...userFlow,
    app_type: "spa",
    callbacks: [`${APP}/review.html`],
    web_origins: [APP],
    allowed_logout_urls: [APP],
  },
  AUD_AUTHORITY,
  [],
);
await ensureClient(
  "mcp-client",
  {
    ...userFlow,
    app_type: "native",
    callbacks: ["http://127.0.0.1:8788/cb"],
  },
  AUD_MCP,
  [],
);
await api("PATCH", `/clients/${state.clients.ciba.client_id}`, {
  grant_types: [
    "authorization_code",
    "refresh_token",
    "urn:openid:params:grant-type:ciba",
  ],
  async_approval_notification_channels: ["guardian-push"],
});
save();

// 3. Database connection for the test users
if (!state.connectionId) {
  const list = await api(
    "GET",
    `/connections?name=${PREFIX}-users&strategy=auth0`,
  );
  state.connectionId =
    list.json[0]?.id ??
    (
      await api("POST", "/connections", {
        name: `${PREFIX}-users`,
        strategy: "auth0",
        enabled_clients: [
          state.clients["reviewer-spa"].client_id,
          state.clients["mcp-client"].client_id,
        ],
        options: { requires_username: false, brute_force_protection: true },
      })
    ).json.id;
  save();
}
const connId = state.connectionId;
// The management client must be enabled on this (new) connection to create users in it.
await api(
  "PATCH",
  `/connections/${connId}/clients`,
  [{ client_id: need("AUTH0_MGMT_CLIENT_ID"), status: true }],
  [400, 404],
);
for (const key of ["reviewer-spa", "mcp-client"])
  await api(
    "PATCH",
    `/connections/${connId}/clients`,
    [{ client_id: state.clients[key].client_id, status: true }],
    [400, 404],
  );

// 4. Organizations
state.orgs ??= {};
for (const name of ["northstar", "southridge"]) {
  if (!state.orgs[name]) {
    const got = await api(
      "GET",
      `/organizations/name/${PREFIX}-${name}`,
      undefined,
      [404],
    );
    state.orgs[name] =
      got.status === 200
        ? got.json.id
        : (
            await api("POST", "/organizations", {
              name: `${PREFIX}-${name}`,
              display_name: `TA-DEMO ${name}`,
            })
          ).json.id;
    save();
  }
  await api(
    "POST",
    `/organizations/${state.orgs[name]}/enabled_connections`,
    { connection_id: connId, assign_membership_on_login: false },
    [409],
  );
}

// 5. Users with a pre-enrolled TOTP factor so step-up can be completed without a phone
state.users ??= {};
for (const [name, org] of USERS) {
  if (!state.users[name]) {
    const email = `${PREFIX}-${name}@example.test`;
    const password = `Ta!${secret()}`;
    const userId = `${PREFIX.replace("-", "_")}_${name}`;
    const made = await api(
      "POST",
      "/users",
      {
        connection: `${PREFIX}-users`,
        user_id: userId,
        email,
        email_verified: true,
        password,
        name,
      },
      [409],
    );
    const id = made.json?.user_id ?? `auth0|${userId}`;
    state.users[name] = { id, email, password, org };
    save();
  }
  const u = state.users[name];
  if (!u.totp) {
    const seed = base32(randomBytes(20));
    const m = await api(
      "POST",
      `/users/${encodeURIComponent(u.id)}/authentication-methods`,
      { type: "totp", totp_secret: seed, name: "ta-demo authenticator" },
    );
    u.totp = seed;
    u.totpMethodId = m.json?.id;
    save();
  }
  await api(
    "POST",
    `/organizations/${state.orgs[org]}/members`,
    { members: [u.id] },
    [409],
  );
}
save();
console.log(
  JSON.stringify(
    {
      domain,
      apis: state.audiences,
      clients: Object.keys(state.clients),
      orgs: state.orgs,
      users: Object.fromEntries(
        Object.entries(state.users).map(([k, v]) => [k, v.id]),
      ),
      stateFile: out,
    },
    null,
    2,
  ),
);

// Optional: a Guardian push enrollment ticket (scan with the Guardian app) for one user.
const ticketFor = process.env.GUARDIAN_TICKET_FOR;
if (ticketFor) {
  const t = await api("POST", "/guardian/enrollments/ticket", {
    user_id: state.users[ticketFor].id,
    send_mail: false,
  });
  console.log(JSON.stringify({ guardianEnrollmentTicket: t.json.ticket_url }));
}
