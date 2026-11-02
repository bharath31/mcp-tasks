#!/usr/bin/env node
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const execFile = promisify(execFileCb);
const ACTION_NAME_PREFIX = "agent-approval";
const CIBA_GRANT = "urn:openid:params:grant-type:ciba";

type JsonRecord = Record<string, any>;
export type ManagementApi = {
  get(path: string): Promise<any>;
  post(path: string, body: unknown): Promise<any>;
  patch(path: string, body: unknown): Promise<any>;
  getClientSecret?(clientId: string): Promise<string | undefined>;
};

export type ApproveInitConfig = {
  tenant: string;
  appUrl: string;
  appName?: string;
  connection?: string;
  roles?: string[];
  push?: boolean;
  audience?: string;
  dryRun?: boolean;
  wrangler?: boolean;
  varsPath?: string;
};

export type ApproveInitDeps = {
  api: ManagementApi;
  out?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  readAction?: (path?: string) => Promise<string>;
};

export class ApproveInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApproveInitError";
  }
}

function array(value: any, key: string): JsonRecord[] {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.[key]) ? value[key] : [];
}

async function connectionHasClient(
  api: ManagementApi,
  connectionId: string,
  clientId: string,
): Promise<boolean> {
  let from: string | undefined;
  const seen = new Set<string>();
  do {
    const result = await api.get(
      `connections/${encodeURIComponent(connectionId)}/clients?take=100${from ? `&from=${encodeURIComponent(from)}` : ""}`,
    );
    if (
      array(result, "clients").some((client) => client.client_id === clientId)
    )
      return true;
    from = result.next;
    if (from && seen.has(from))
      throw new ApproveInitError("Auth0 repeated a connection client cursor.");
    if (from) seen.add(from);
  } while (from);
  return false;
}

async function allConnections(api: ManagementApi): Promise<JsonRecord[]> {
  const connections: JsonRecord[] = [];
  for (let page = 0; ; page++) {
    const result = await api.get(
      `connections?fields=id,name&include_fields=true&per_page=100&page=${page}&include_totals=true`,
    );
    const items = array(result, "connections");
    connections.push(...items);
    if (
      !items.length ||
      (typeof result.total === "number"
        ? connections.length >= result.total
        : items.length < 100)
    )
      return connections;
  }
}

function appendActionBindings(existing: JsonRecord[], action: JsonRecord) {
  const found = existing.some(
    (binding) =>
      binding.action?.id === action.id || binding.action?.name === action.name,
  );
  const payload = [
    ...existing.map((binding) => ({
      ref: { type: "binding_id", value: binding.id },
      ...(binding.display_name ? { display_name: binding.display_name } : {}),
    })),
    ...(!found
      ? [
          {
            ref: { type: "action_id", value: action.id },
            display_name: action.name,
          },
        ]
      : []),
  ];
  const ids = payload
    .filter((item) => item.ref.type === "binding_id")
    .map((item) => item.ref.value);
  const expected = existing.map((binding) => binding.id);
  if (JSON.stringify(ids) !== JSON.stringify(expected))
    throw new ApproveInitError(
      "Refusing to update the Login flow because an existing binding would be dropped or reordered.",
    );
  return { payload, changed: !found };
}

function validate(config: ApproveInitConfig) {
  const tenant = config.tenant
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!/^[a-z0-9.-]+$/i.test(tenant))
    throw new ApproveInitError("--tenant must be an Auth0 tenant domain.");
  let appUrl: URL;
  try {
    appUrl = new URL(config.appUrl);
  } catch {
    throw new ApproveInitError("--app-url must be an absolute http(s) URL.");
  }
  if (!/^(https?:)$/.test(appUrl.protocol))
    throw new ApproveInitError("--app-url must use http or https.");
  if (config.push && !config.audience)
    throw new ApproveInitError("--push requires --audience.");
  if (config.audience && !config.push)
    throw new ApproveInitError("--audience is only used with --push.");
  return { tenant, appUrl: appUrl.toString().replace(/\/$/, "") };
}

/** Idempotently provisions a Regular Web App and the approval Action. */
export async function initApprovals(
  config: ApproveInitConfig,
  deps: ApproveInitDeps,
): Promise<void> {
  const { tenant, appUrl } = validate(config);
  const api = deps.api;
  const say = deps.out ?? console.log;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const connectionName =
    config.connection ?? "Username-Password-Authentication";
  const roles = [
    ...new Set(
      (config.roles?.length ? config.roles : ["finance"])
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  const appLabel = config.appName ?? "Refund Workflow";
  const appName = `Agent approvals (${appLabel})`;
  const actionName = `${ACTION_NAME_PREFIX} (${appLabel})`;
  const callback = `${appUrl}/approve/callback`;
  const grants = ["authorization_code", ...(config.push ? [CIBA_GRANT] : [])];
  const sayPlan = (line: string) =>
    say(`${config.dryRun ? "PLAN" : "DO"} ${line}`);

  sayPlan(`configure ${appName} on ${tenant}`);
  sayPlan(`callback ${callback}`);
  sayPlan(`configure approval sign-in on connection ${connectionName}`);
  sayPlan(
    `deploy Action ${actionName} and append it to Login without removing bindings`,
  );
  for (const role of roles) sayPlan(`ensure role ${role}`);
  if (config.push)
    sayPlan(`enable CIBA and register agent_action on ${config.audience}`);

  const apps = array(
    await api.get(
      "clients?fields=client_id,name,app_type,oidc_conformant,is_first_party,grant_types,callbacks,allowed_logout_urls,web_origins,token_endpoint_auth_method,client_metadata&include_fields=true&per_page=100",
    ),
    "clients",
  );
  const existingApp = apps.find((item) => item.name === appName);
  const connectionList = array(
    await api.get(
      `connections?name=${encodeURIComponent(connectionName)}&fields=id,name,strategy,options&include_fields=true&per_page=100`,
    ),
    "connections",
  );
  const connection = connectionList.find(
    (item) => item.name === connectionName,
  );
  if (!connection || !["auth0", "email"].includes(connection.strategy))
    throw new ApproveInitError(
      `Auth0 database or email connection "${connectionName}" was not found.`,
    );
  const emailOtp = connection.strategy === "email";
  sayPlan(
    emailOtp
      ? "use email OTP followed by a fresh WebAuthn challenge and assurance Action"
      : "use a passkey as the first factor",
  );
  if (config.dryRun) return;
  let webauthnFactors: string[] = [];
  if (emailOtp) {
    const tenantSettings = await api.get("tenants/settings");
    if (tenantSettings.customize_mfa_in_postlogin_action !== true)
      throw new ApproveInitError(
        "Enable Customize MFA Factors using Actions on the tenant before setting up email OTP approvals.",
      );
    const factors = array(await api.get("guardian/factors"), "factors");
    webauthnFactors = factors
      .filter(
        (factor) =>
          ["webauthn-platform", "webauthn-roaming"].includes(factor.name) &&
          factor.enabled === true,
      )
      .map((factor) => factor.name);
    if (!webauthnFactors.length)
      throw new ApproveInitError(
        "Email OTP approvals require an enabled WebAuthn MFA factor on this tenant.",
      );
  }

  const options = connection.options ?? {};
  const authMethods = options.authentication_methods ?? {};
  const needsPasskey = !emailOtp && authMethods.passkey?.enabled !== true;
  if (needsPasskey) {
    sayPlan(`enable passkeys on ${connectionName}`);
    await api.patch(`connections/${encodeURIComponent(connection.id)}`, {
      options: {
        ...options,
        authentication_methods: {
          ...authMethods,
          passkey: { ...(authMethods.passkey ?? {}), enabled: true },
        },
      },
    });
  } else if (!emailOtp)
    say(`SKIP passkeys already enabled on ${connectionName}`);

  const details: JsonRecord = {
    name: appName,
    app_type: "regular_web",
    oidc_conformant: true,
    is_first_party: true,
    token_endpoint_auth_method: "client_secret_post",
    grant_types: grants,
    callbacks: [callback],
    allowed_logout_urls: [appUrl],
    web_origins: [appUrl],
    client_metadata: {
      ...(existingApp?.client_metadata ?? {}),
      task_authority_approval: emailOtp ? "webauthn-mfa" : "passkey",
      ...(emailOtp ? { approval_mfa_factors: webauthnFactors.join(",") } : {}),
    },
  };
  let app: JsonRecord;
  let clientSecret: string | undefined;
  if (!existingApp) {
    app = await api.post("clients", details);
    clientSecret = app.client_secret;
    say(`CREATED ${appName}`);
  } else {
    app = existingApp;
    const update: JsonRecord = {};
    for (const key of [
      "app_type",
      "oidc_conformant",
      "is_first_party",
      "token_endpoint_auth_method",
      "grant_types",
      "callbacks",
      "allowed_logout_urls",
      "web_origins",
      "client_metadata",
    ]) {
      const desired = details[key];
      if (JSON.stringify(existingApp[key] ?? []) !== JSON.stringify(desired))
        update[key] = desired;
    }
    if (Object.keys(update).length) {
      await api.patch(`clients/${encodeURIComponent(app.client_id)}`, update);
      say(`UPDATED ${appName}`);
    } else say(`SKIP ${appName} already configured`);
  }
  if (config.push && config.audience) {
    const servers = array(
      await api.get("resource-servers?per_page=100"),
      "resource_servers",
    );
    const server = servers.find((item) => item.identifier === config.audience);
    const serverDetails = {
      name: `${appLabel} approvals`,
      identifier: config.audience,
      signing_alg: "RS256",
      token_dialect: "access_token",
      authorization_details: [{ type: "agent_action" }],
    };
    if (!server) {
      await api.post("resource-servers", serverDetails);
      say(`CREATED API ${config.audience}`);
    } else {
      const current = Array.isArray(server.authorization_details)
        ? server.authorization_details
        : [];
      if (!current.some((item: JsonRecord) => item.type === "agent_action")) {
        await api.patch(
          `resource-servers/${encodeURIComponent(server.id ?? server.identifier)}`,
          { authorization_details: [...current, { type: "agent_action" }] },
        );
        say(`UPDATED API authorization_details for ${config.audience}`);
      } else say(`SKIP API ${config.audience} already has agent_action`);
    }
  }

  const clientId = app.client_id;
  if (!clientId) throw new ApproveInitError("Auth0 returned no client ID.");
  if (!(await connectionHasClient(api, connection.id, clientId))) {
    await api.patch(
      `connections/${encodeURIComponent(connection.id)}/clients`,
      [{ client_id: clientId, status: true }],
    );
    say(`ENABLED ${connectionName} for ${appName}`);
  }
  if (emailOtp) {
    for (const other of await allConnections(api)) {
      if (
        other.id === connection.id ||
        !(await connectionHasClient(api, other.id, clientId))
      )
        continue;
      await api.patch(`connections/${encodeURIComponent(other.id)}/clients`, [
        { client_id: clientId, status: false },
      ]);
      say(`DISABLED ${other.name} for ${appName} (email OTP only)`);
    }
  }

  for (const roleName of roles) {
    const found = array(
      await api.get(
        `roles?name_filter=${encodeURIComponent(roleName)}&per_page=100`,
      ),
      "roles",
    ).find((item) => item.name === roleName);
    if (!found) {
      await api.post("roles", {
        name: roleName,
        description: `Approvers for ${appLabel}`,
      });
      say(`CREATED role ${roleName}`);
    } else say(`SKIP role ${roleName} already exists`);
  }

  const actionSources = emailOtp
    ? ["agent-approval-mfa", "agent-approval-assurance"]
    : ["agent-approval"];
  for (const actionSource of actionSources) {
    const actionName = `${actionSource} (${appLabel})`;
    const sourcePath = `auth0/actions/${actionSource}.cjs`;
    const source = (
      await (deps.readAction?.(sourcePath) ??
        readFile(resolve(sourcePath), "utf8"))
    ).replace('"__APPROVAL_CLIENT_ID__"', JSON.stringify(clientId));
    const actionList = array(
      await api.get(
        `actions/actions?actionName=${encodeURIComponent(actionName)}&per_page=100`,
      ),
      "actions",
    );
    let action = actionList.find((item) => item.name === actionName);
    let deploy = false;
    if (!action) {
      action = await api.post("actions/actions", {
        name: actionName,
        supported_triggers: [{ id: "post-login", version: "v3" }],
        code: source,
        runtime: "node22",
      });
      deploy = true;
      say(`CREATED Action ${actionName}`);
    } else if (action.code !== source) {
      await api.patch(`actions/actions/${encodeURIComponent(action.id)}`, {
        code: source,
      });
      deploy = true;
      say(`UPDATED Action ${actionName}`);
    } else {
      deploy =
        action.status !== "built" || action.all_changes_deployed !== true;
      if (!deploy) say(`SKIP Action ${actionName} is current`);
    }
    if (!action)
      throw new ApproveInitError(`Auth0 returned no Action ${actionName}.`);
    let readyAction: JsonRecord = action;
    if (deploy) {
      await api.post(
        `actions/actions/${encodeURIComponent(readyAction.id)}/deploy`,
        {},
      );
      for (let attempt = 0; attempt < 60; attempt++) {
        await sleep(1000);
        const currentAction = await api.get(
          `actions/actions/${encodeURIComponent(readyAction.id)}`,
        );
        if (!currentAction)
          throw new ApproveInitError(
            `Action ${actionName} disappeared while building.`,
          );
        readyAction = currentAction;
        if (readyAction.status === "failed")
          throw new ApproveInitError(`Action ${actionName} failed to build.`);
        if (
          readyAction.status === "built" &&
          readyAction.all_changes_deployed === true
        )
          break;
        if (attempt === 59)
          throw new ApproveInitError(
            `Timed out building Action ${actionName}.`,
          );
      }
      say(`DEPLOYED Action ${actionName}`);
    }

    const bindings = array(
      await api.get("actions/triggers/post-login/bindings?per_page=100"),
      "bindings",
    );
    const bindingPlan = appendActionBindings(bindings, readyAction);
    if (bindingPlan.changed) {
      await api.patch("actions/triggers/post-login/bindings", {
        bindings: bindingPlan.payload,
      });
      say(`BOUND ${actionName} at the end of the Login flow`);
    } else say(`SKIP Action ${actionName} already bound`);
  }

  if (emailOtp) {
    const flow = array(
      await api.get("actions/triggers/post-login/bindings?per_page=100"),
      "bindings",
    );
    const challengeIndex = flow.findIndex(
      (binding) => binding.action?.name === `agent-approval-mfa (${appLabel})`,
    );
    const assuranceIndex = flow.findIndex(
      (binding) =>
        binding.action?.name === `agent-approval-assurance (${appLabel})`,
    );
    if (challengeIndex < 0 || assuranceIndex <= challengeIndex)
      throw new ApproveInitError(
        "The WebAuthn challenge Action must run before its assurance Action. Correct the Login flow order before using this app.",
      );
  }

  if (!clientSecret && api.getClientSecret)
    clientSecret = await api.getClientSecret(clientId);
  if (!clientSecret)
    throw new ApproveInitError(
      "Auth0 did not return the app secret. Re-run init or retrieve it from the Auth0 dashboard; no secret was printed.",
    );

  if (config.wrangler) {
    for (const key of [
      "AUTH0_DOMAIN",
      "AUTH0_CLIENT_ID",
      "AUTH0_CLIENT_SECRET",
      "APP_URL",
      "AUTH0_APPROVAL_CONNECTION",
      "AUTH0_APPROVAL_LOGIN_METHOD",
      ...(config.push ? ["AUTH0_APPROVAL_AUDIENCE"] : []),
    ])
      say(`npx wrangler secret put ${key}`);
  } else {
    const vars = new Map([
      ["AUTH0_DOMAIN", tenant],
      ["AUTH0_CLIENT_ID", clientId],
      ["AUTH0_CLIENT_SECRET", clientSecret],
      ["APP_URL", appUrl],
      ["AUTH0_APPROVAL_CONNECTION", connectionName],
      ["AUTH0_APPROVAL_LOGIN_METHOD", emailOtp ? "email-otp" : "passkey"],
      ...(config.push && config.audience
        ? [["AUTH0_APPROVAL_AUDIENCE", config.audience] as const]
        : []),
    ]);
    const varsPath = resolve(
      config.varsPath ?? "demo/refund-workflow/.dev.vars",
    );
    let current = "";
    try {
      current = await readFile(varsPath, "utf8");
    } catch {
      // First setup: create the ignored local vars file below.
    }
    const seen = new Set<string>();
    const lines = current
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        const name = line.slice(0, index);
        if (!vars.has(name)) return line;
        seen.add(name);
        return `${name}=${vars.get(name)}`;
      });
    for (const [key, value] of vars)
      if (!seen.has(key)) lines.push(`${key}=${value}`);
    await writeFile(varsPath, `${lines.join("\n")}\n`, { mode: 0o600 });
    await chmod(varsPath, 0o600);
    say(`WROTE ${varsPath} (secrets redacted)`);
  }
}

/** Auth0 CLI is the credential broker; no Management API token is printed or stored. */
export function auth0CliApi(tenant: string): ManagementApi {
  const request = async (method: string, path: string, body?: unknown) => {
    const args = [
      "api",
      method.toLowerCase(),
      path,
      "--tenant",
      tenant,
      "--no-input",
    ];
    if (body !== undefined) args.push("--data", JSON.stringify(body));
    try {
      const { stdout } = await execFile("auth0", args, {
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout.trim() ? JSON.parse(stdout) : undefined;
    } catch {
      throw new ApproveInitError(
        `Auth0 CLI request failed for ${method} ${path.split("?")[0]}. Check the CLI login and Management API scopes.`,
      );
    }
  };
  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    async getClientSecret(clientId) {
      try {
        const { stdout } = await execFile(
          "auth0",
          [
            "apps",
            "show",
            clientId,
            "--reveal-secrets",
            "--json",
            "--tenant",
            tenant,
            "--no-input",
          ],
          { maxBuffer: 1024 * 1024 },
        );
        const result = JSON.parse(stdout) as JsonRecord;
        const app = result.client ?? result;
        return typeof app.client_secret === "string"
          ? app.client_secret
          : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

function parse(argv: string[]): ApproveInitConfig {
  const config: Partial<ApproveInitConfig> = { roles: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--"))
        throw new ApproveInitError(`Missing value for ${arg}.`);
      return next;
    };
    switch (arg) {
      case "--tenant":
        config.tenant = value();
        break;
      case "--app-url":
        config.appUrl = value();
        break;
      case "--app-name":
        config.appName = value();
        break;
      case "--vars-path":
        config.varsPath = value();
        break;
      case "--connection":
        config.connection = value();
        break;
      case "--role":
        config.roles!.push(value());
        break;
      case "--push":
        config.push = true;
        break;
      case "--audience":
        config.audience = value();
        break;
      case "--dry-run":
        config.dryRun = true;
        break;
      case "--wrangler":
        config.wrangler = true;
        break;
      default:
        throw new ApproveInitError(`Unknown option ${arg}.`);
    }
  }
  if (!config.tenant || !config.appUrl)
    throw new ApproveInitError(
      "Usage: task-authority approve init --tenant <domain> --app-url <origin> [--app-name name] [--vars-path file] [--connection name] [--role name] [--push --audience URL] [--dry-run] [--wrangler]",
    );
  return config as ApproveInitConfig;
}

export async function runApproveInitCli(
  argv: string[],
  deps: Omit<ApproveInitDeps, "api"> & { api?: ManagementApi } = {},
): Promise<number> {
  try {
    const config = parse(argv);
    await initApprovals(config, {
      ...deps,
      api: deps.api ?? auth0CliApi(config.tenant),
    });
    return 0;
  } catch (error) {
    (deps.out ?? console.log)(
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }
}
