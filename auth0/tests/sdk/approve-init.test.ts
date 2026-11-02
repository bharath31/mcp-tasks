import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { initApprovals, type ManagementApi } from "../../tools/approve-init.js";

const SECRET = "only-in-memory-app-secret";
const ACTION = "exports.onExecutePostLogin = async () => {};";
let server: ReturnType<typeof createServer>;
let origin: string;
let temp: string;
let state: {
  clients: Record<string, any>[];
  connections: Record<string, any>[];
  roles: Record<string, any>[];
  actions: Record<string, any>[];
  bindings: Record<string, any>[];
  writes: string[];
};

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "approve-init-"));
  state = {
    clients: [],
    connections: [
      {
        id: "connection-1",
        name: "Username-Password-Authentication",
        strategy: "auth0",
        options: {
          authentication_methods: {
            password: { enabled: true },
            passkey: { enabled: false },
          },
          existing_option: "preserved",
        },
        clients: [],
      },
      { id: "connection-email", name: "email", strategy: "email", clients: [] },
    ],
    roles: [],
    actions: [],
    bindings: [
      {
        id: "binding-existing",
        display_name: "Existing Login Action",
        action: { id: "action-existing", name: "Existing Login Action" },
      },
    ],
    writes: [],
  };
  server = createServer(async (req, res) => handle(req, res));
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(temp, { recursive: true, force: true });
});

function reply(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", origin);
  const method = req.method ?? "GET";
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString())
    : {};
  assert.equal(req.headers.authorization, "Bearer local-test-token");
  if (method !== "GET") state.writes.push(`${method} ${url.pathname}`);

  if (url.pathname === "/clients" && method === "GET") {
    const fields = url.searchParams.get("fields")?.split(",") ?? [];
    return reply(
      res,
      state.clients.map((client) =>
        Object.fromEntries(fields.map((field) => [field, client[field]])),
      ),
    );
  }
  if (url.pathname === "/clients" && method === "POST") {
    const app = {
      ...body,
      client_id: `client-${state.clients.length + 1}`,
      client_secret: SECRET,
    };
    state.clients.push(app);
    return reply(res, app, 201);
  }
  if (url.pathname === "/connections" && method === "GET") {
    // Current Auth0 connection responses omit application associations.
    const connections = state.connections.map(({ clients, ...rest }) => rest);
    if (url.searchParams.has("name"))
      return reply(
        res,
        connections.filter((c) => c.name === url.searchParams.get("name")),
      );
    // Force a second page so password fallback removal covers all connections.
    connections.reverse();
    const page = Number(url.searchParams.get("page") ?? 0);
    return reply(res, {
      connections: connections.slice(page, page + 1),
      total: connections.length,
    });
  }
  if (
    /^\/connections\/[^/]+\/clients$/.test(url.pathname) &&
    method === "GET"
  ) {
    assert.equal(url.searchParams.get("take"), "100");
    const connection = state.connections.find(
      (item) => item.id === url.pathname.split("/")[2],
    )!;
    const from = Number(url.searchParams.get("from") ?? 0);
    const clients = connection.clients.slice(from, from + 1);
    return reply(res, {
      clients,
      ...(from + 1 < connection.clients.length
        ? { next: String(from + 1) }
        : {}),
    });
  }
  if (url.pathname === "/guardian/factors" && method === "GET")
    return reply(res, [{ name: "webauthn-platform", enabled: true }]);
  if (url.pathname === "/tenants/settings" && method === "GET")
    return reply(res, { customize_mfa_in_postlogin_action: true });
  if (/^\/clients\/[^/]+$/.test(url.pathname) && method === "PATCH") {
    const client = state.clients.find(
      (item) => item.client_id === url.pathname.split("/")[2],
    )!;
    Object.assign(client, body);
    return reply(res, client);
  }
  if (url.pathname === "/connections/connection-1" && method === "PATCH") {
    state.connections[0] = { ...state.connections[0], ...body };
    return reply(res, state.connections[0]);
  }
  if (
    /^\/connections\/[^/]+\/clients$/.test(url.pathname) &&
    method === "PATCH"
  ) {
    const wanted = body[0];
    const connection = state.connections.find(
      (item) => item.id === url.pathname.split("/")[2],
    )!;
    if (wanted.status === false)
      connection.clients = connection.clients.filter(
        (client: any) => client.client_id !== wanted.client_id,
      );
    else connection.clients.push({ client_id: wanted.client_id });
    return reply(res, { ok: true });
  }
  if (url.pathname === "/roles" && method === "GET")
    return reply(
      res,
      state.roles.filter(
        (role) => role.name === url.searchParams.get("name_filter"),
      ),
    );
  if (url.pathname === "/roles" && method === "POST") {
    const role = { ...body, id: `role-${state.roles.length + 1}` };
    state.roles.push(role);
    return reply(res, role, 201);
  }
  if (url.pathname === "/actions/actions" && method === "GET")
    return reply(res, {
      actions: state.actions.filter(
        (action) => action.name === url.searchParams.get("actionName"),
      ),
    });
  if (url.pathname === "/actions/actions" && method === "POST") {
    const action = {
      ...body,
      id: `action-${state.actions.length + 1}`,
      status: "built",
      all_changes_deployed: true,
    };
    state.actions.push(action);
    return reply(res, action, 201);
  }
  if (/^\/actions\/actions\/[^/]+$/.test(url.pathname) && method === "GET")
    return reply(
      res,
      state.actions.find((action) => action.id === url.pathname.split("/")[3]),
    );
  if (
    /^\/actions\/actions\/[^/]+\/deploy$/.test(url.pathname) &&
    method === "POST"
  )
    return reply(res, { status: "built" });
  if (
    url.pathname === "/actions/triggers/post-login/bindings" &&
    method === "GET"
  )
    return reply(res, { bindings: state.bindings });
  if (
    url.pathname === "/actions/triggers/post-login/bindings" &&
    method === "PATCH"
  ) {
    const refs = body.bindings as {
      ref: { type: string; value: string };
      display_name?: string;
    }[];
    const kept = refs.filter((binding) => binding.ref.type === "binding_id");
    assert.deepEqual(
      kept.map((binding) => binding.ref.value),
      state.bindings.map((binding) => binding.id),
    );
    state.bindings = refs.map((binding, index) =>
      binding.ref.type === "binding_id"
        ? state.bindings.find((current) => current.id === binding.ref.value)!
        : {
            id: `binding-new-${index}`,
            display_name: binding.display_name,
            action: state.actions.find(
              (action) => action.id === binding.ref.value,
            ),
          },
    );
    return reply(res, { bindings: state.bindings });
  }
  res.writeHead(404);
  res.end();
}

function localApi(): ManagementApi {
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(new URL(path, origin), {
      method,
      headers: {
        authorization: "Bearer local-test-token",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(`local management API returned ${response.status}`);
    return response.json();
  };
  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    getClientSecret: async () => SECRET,
  };
}

test("approve init is idempotent, preserves bindings, and redacts secrets", async () => {
  const varsPath = join(temp, ".dev.vars");
  const output: string[] = [];
  const config = {
    tenant: "example.us.auth0.com",
    appUrl: "https://refunds.example.com",
    appName: "Refund Workflow",
    roles: ["finance"],
    varsPath,
  };
  const deps = {
    api: localApi(),
    out: (line: string) => output.push(line),
    sleep: async () => {},
    readAction: async () => ACTION,
  };

  await initApprovals(config, deps);
  const firstWriteCount = state.writes.length;
  assert.ok(firstWriteCount > 0);
  assert.deepEqual(
    state.bindings.map((binding) => binding.id),
    ["binding-existing", "binding-new-1"],
  );
  assert.equal(
    state.connections[0]?.options.authentication_methods.passkey.enabled,
    true,
  );
  assert.equal(state.connections[0]?.options.existing_option, "preserved");

  await initApprovals(config, deps);
  assert.equal(state.writes.length, firstWriteCount);

  const vars = await readFile(varsPath, "utf8");
  assert.match(vars, /AUTH0_CLIENT_ID=client-1/);
  assert.match(vars, new RegExp(`AUTH0_CLIENT_SECRET=${SECRET}`));
  assert.equal((await stat(varsPath)).mode & 0o777, 0o600);
  assert.ok(output.every((line) => !line.includes(SECRET)));
});

test("dry run does not write to Auth0 or create a vars file", async () => {
  const before = state.writes.length;
  const varsPath = join(temp, "dry-run.vars");
  const output: string[] = [];
  await initApprovals(
    {
      tenant: "example.us.auth0.com",
      appUrl: "https://refunds.example.com",
      dryRun: true,
      varsPath,
    },
    {
      api: localApi(),
      out: (line) => output.push(line),
      readAction: async () => ACTION,
    },
  );
  assert.equal(state.writes.length, before);
  await assert.rejects(readFile(varsPath));
  assert.ok(output.some((line) => line.includes("PLAN")));
});

test("email OTP init deploys an ordered WebAuthn challenge and assurance pair", async () => {
  const varsPath = join(temp, "email.vars");
  const config = {
    tenant: "example.us.auth0.com",
    appUrl: "https://refunds.example.com",
    appName: "Email approvals",
    connection: "email",
    varsPath,
  };
  const deps = { api: localApi(), out: () => {}, sleep: async () => {} };
  const existing = state.bindings.map((binding) => binding.id);
  await initApprovals(config, deps);
  assert.deepEqual(
    state.bindings.slice(0, existing.length).map((binding) => binding.id),
    existing,
  );
  assert.deepEqual(
    state.bindings.slice(-2).map((binding) => binding.action.name),
    [
      "agent-approval-mfa (Email approvals)",
      "agent-approval-assurance (Email approvals)",
    ],
  );
  assert.equal(
    state.clients.at(-1)?.client_metadata.task_authority_approval,
    "webauthn-mfa",
  );
  const vars = await readFile(varsPath, "utf8");
  assert.match(vars, /AUTH0_APPROVAL_CONNECTION=email/);
  assert.match(vars, /AUTH0_APPROVAL_LOGIN_METHOD=email-otp/);
  const writes = state.writes.length;
  await initApprovals(config, deps);
  assert.equal(state.writes.length, writes);
  assert.ok(
    state.actions
      .slice(-2)
      .every((action) => !action.code.includes("__APPROVAL_CLIENT_ID__")),
  );
  await initApprovals(
    { ...config, connection: "Username-Password-Authentication" },
    deps,
  );
  const switched = await readFile(varsPath, "utf8");
  assert.match(
    switched,
    /AUTH0_APPROVAL_CONNECTION=Username-Password-Authentication/,
  );
  assert.match(switched, /AUTH0_APPROVAL_LOGIN_METHOD=passkey/);
  await initApprovals(config, deps);
  assert.equal(
    state.connections[0]?.clients.some(
      (client: any) => client.client_id === state.clients.at(-1)?.client_id,
    ),
    false,
    "email OTP mode removes password-capable connection access from this app only",
  );
  assert.ok(
    state.connections[0]?.clients.some(
      (client: any) => client.client_id === state.clients[0]?.client_id,
    ),
    "other applications keep their connection access",
  );
});

test("email OTP setup refuses missing custom-MFA support before tenant writes", async () => {
  const api = localApi();
  const count = state.writes.length;
  await assert.rejects(
    initApprovals(
      {
        tenant: "example.us.auth0.com",
        appUrl: "https://refunds.example.com",
        connection: "email",
        varsPath: join(temp, "disabled.vars"),
      },
      {
        api: {
          ...api,
          get: async (path) =>
            path === "tenants/settings"
              ? { customize_mfa_in_postlogin_action: false }
              : api.get(path),
        },
        out: () => {},
      },
    ),
    /Customize MFA Factors/,
  );
  assert.equal(state.writes.length, count);
});
