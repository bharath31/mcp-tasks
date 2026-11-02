// Deployment smoke check for the SEPARATELY deployed service and customer app.
// Opt-in (needs network access to the deployments); does not need credentials.
//   TASK_AUTHORITY_URL=https://... REFUND_DESK_URL=https://... \
//   [ALLOWED_ORIGIN=https://app.example] node --import tsx scripts/verify-live.ts
// It proves reachability, error contracts, origin policy and that no secrets leak.
// It does NOT prove Auth0 sign-in, FGA correctness or Stripe behaviour.
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v.replace(/\/$/, "");
};
const authority = need("TASK_AUTHORITY_URL");
const desk = need("REFUND_DESK_URL");
const evil = "https://evil.example";
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
  );
};
const SECRETS =
  /sk_(live|test)_[A-Za-z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{30,}\.eyJ|service_role|client_secret/;
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "verify-live", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/tasks": {} },
  },
};
const rpc = (method: string) =>
  fetch(`${desk}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { _meta: meta },
    }),
  });

const a = await fetch(`${authority}/healthz`);
const aBody = await a.text();
check(
  "authority /healthz is 200 and minimal",
  a.status === 200 &&
    Object.keys(JSON.parse(aBody)).sort().join() === "contract,status",
  aBody.slice(0, 80),
);
const unauth = await fetch(`${authority}/v1/operations/op_x`);
const ub = (await unauth.json()) as Record<string, unknown>;
check(
  "authority rejects unauthenticated calls with the error contract",
  unauth.status === 401 &&
    ub.code === "invalid_identity" &&
    typeof ub.correlationId === "string" &&
    typeof ub.retryable === "boolean",
);
const cors = await fetch(`${authority}/healthz`, { headers: { origin: evil } });
check(
  "authority does not grant CORS to unknown origins",
  cors.headers.get("access-control-allow-origin") === null,
);
const pre = await fetch(`${authority}/v1/approval-requests/x/decisions`, {
  method: "OPTIONS",
  headers: { origin: evil },
});
check(
  "authority refuses CORS preflight from unknown origins",
  pre.status === 403,
);
if (process.env.ALLOWED_ORIGIN) {
  const ok = await fetch(`${authority}/healthz`, {
    headers: { origin: process.env.ALLOWED_ORIGIN },
  });
  check(
    "authority allows the configured reviewer origin",
    ok.headers.get("access-control-allow-origin") ===
      process.env.ALLOWED_ORIGIN,
  );
}
check(
  "authority responses are not cacheable",
  a.headers.get("cache-control") === "no-store",
);

const d = await fetch(`${desk}/healthz`);
const dBody = (await d.json()) as {
  status?: string;
  providerMode?: string;
  demoMode?: boolean;
};
check(
  "app /healthz is ok and states its provider mode",
  d.status === 200 &&
    dBody.status === "ok" &&
    ["simulator", "stripe-test"].includes(String(dBody.providerMode)),
  JSON.stringify(dBody),
);
const prm = await fetch(`${desk}/.well-known/oauth-protected-resource`);
const prmBody = (await prm.json()) as { authorization_servers?: string[] };
check(
  "app publishes RFC 9728 protected-resource metadata",
  prm.status === 200 &&
    Array.isArray(prmBody.authorization_servers) &&
    prmBody.authorization_servers.length > 0,
);
const disc = (await (await rpc("server/discover")).json()) as {
  result?: {
    supportedVersions?: string[];
    capabilities?: { extensions?: Record<string, unknown> };
  };
};
check(
  "server/discover advertises 2026-07-28 and the tasks extension",
  disc.result?.supportedVersions?.includes("2026-07-28") === true &&
    "io.modelcontextprotocol/tasks" in
      (disc.result?.capabilities?.extensions ?? {}),
);
const noTok = await rpc("tools/list");
check(
  "MCP calls without a token get 401 and a resource_metadata challenge",
  noTok.status === 401 &&
    /resource_metadata=/.test(noTok.headers.get("www-authenticate") ?? ""),
);
const op = await fetch(`${desk}/operator/task`);
check(
  dBody.demoMode
    ? "demo mode: operator API demands its token"
    : "operator API is not mounted outside demo mode",
  dBody.demoMode ? op.status === 401 : op.status === 404,
  `status ${op.status}`,
);
const wh = await fetch(`${desk}/api/warehouse/events`, {
  method: "POST",
  body: "{}",
});
check("warehouse ingress refuses unsigned events", wh.status === 401);
const bodies = [
  aBody,
  JSON.stringify(dBody),
  JSON.stringify(prmBody),
  JSON.stringify(disc),
  await (await fetch(`${desk}/api/config`)).text(),
];
check(
  "no secret-shaped values in public responses",
  !bodies.some((b) => SECRETS.test(b)),
);

const failed = results.filter((r) => !r[1]);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`,
);
process.exit(failed.length ? 1 : 0);
