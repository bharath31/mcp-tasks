// Runs the full local stack (Task Authority, Refund Desk, local OIDC provider, FGA fake) for a
// real MCP host such as Claude Code, and plays the people the host cannot: the warehouse that
// confirms the return, and the person who approves. Postgres must be up (`npm run db:up`). Writes an MCP config with a bearer token for Alice and keeps running until Ctrl-C.
//
//   npm run local -- [--owner] [--out .local/claude-code.mcp.json]
//   claude --mcp-config .local/claude-code.mcp.json --strict-mcp-config
//
// Without --owner, Morgan (a manager) approves each pending refund a few seconds after it is
// requested. With --owner, policy lets Alice approve her own agent's refund: the task asks the
// host with a URL elicitation, and only after the host answers it does Alice approve with a
// passkey. Elicitation answers never approve anything; the decision goes to Task Authority.
// With OWNER_APPROVAL_PROMPT=status as well, the task never asks the host for input (for
// headless runs such as `claude -p`), and Alice approves as soon as the approval is pending.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import { startStack } from "../helpers/stack.js";

const args = process.argv.slice(2);
const owner = args.includes("--owner");
// OWNER_APPROVAL_PROMPT=status (inherited by the app): the owner is pointed at the page, not asked.
const statusOnly = process.env.OWNER_APPROVAL_PROMPT === "status";
const out = args.includes("--out")
  ? args[args.indexOf("--out") + 1]!
  : ".local/claude-code.mcp.json"; // .local/ is gitignored: the file holds a bearer token
const log = (event: string, detail: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({ at: new Date().toISOString(), event, ...detail }),
  );

const s = await startStack();
const app = new pg.Pool({ connectionString: s.appDb.url, max: 2 });
const svc = new pg.Pool({ connectionString: s.serviceDb.url, max: 2 });

if (owner) {
  const { resource_server: rs, active_version: active } = (
    await svc.query(
      "select resource_server, active_version from authority.policy_state where tenant_id='tnt_demo'",
    )
  ).rows[0];
  const doc = (
    await svc.query(
      "select document from authority.policy_versions where tenant_id='tnt_demo' and resource_server=$1 and version=$2",
      [rs, active],
    )
  ).rows[0].document;
  doc.version = "owner-approval-local";
  doc.actions["refund:create"].self_approval = "owner";
  await svc.query(
    "insert into authority.policy_versions(tenant_id,resource_server,version,document,created_by,created_at) values('tnt_demo',$1,$2,$3,'claude-code-stack',now())",
    [rs, doc.version, JSON.stringify(doc)],
  );
  await svc.query(
    "update authority.policy_state set active_version=$2 where tenant_id='tnt_demo' and resource_server=$1",
    [rs, doc.version],
  );
}

const token = await s.login("alice");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      mcpServers: {
        "refund-desk": {
          type: "http",
          url: `${s.appOrigin}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  ),
);
log("ready", {
  mcp: `${s.appOrigin}/mcp`,
  config: out,
  owner,
  tokenTtlS: 3600,
});

/** The approver's decision, made at the service with their own bound, step-up token. */
async function approve(userKey: string, approvalId: string, digest: string) {
  const t = await s.login(userKey, {
    client: "reviewer_spa",
    audience: "https://task-authority.local/api",
    details: [
      {
        type: "task_authority_approval",
        approval_id: approvalId,
        operation_digest: digest,
      },
    ],
    factor: owner ? "webauthn-platform" : undefined,
  });
  const r = await fetch(
    `${s.serviceUrl}/v1/approval-requests/${approvalId}/decisions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${t}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approve", operationDigest: digest }),
    },
  );
  return r.status;
}

const seen = new Map<string, number>();
const tick = async () => {
  const tasks = (
    await app.query(
      "select task_id, org_id, stage, status, operation_id, answered_inputs, request->>'orderId' order_id, request->>'paymentId' payment_id from refund_desk.tasks where status in ('working','input_required')",
    )
  ).rows;
  for (const t of tasks) {
    if (t.stage === "awaiting_return" && !seen.has(`ret:${t.task_id}`)) {
      seen.set(`ret:${t.task_id}`, Date.now());
      const r = await s.warehouse(
        s.appOrigin,
        t.order_id,
        t.payment_id,
        t.org_id,
      );
      log("warehouse_return_confirmed", {
        taskId: t.task_id,
        status: r.status,
      });
    }
    if (!t.operation_id) continue;
    const op = (await s.authorityGet(`/v1/operations/${t.operation_id}`)).json;
    if (op.approvalStatus !== "pending" || seen.has(`ok:${op.approvalId}`))
      continue;
    // The owner approves only after their host answered the URL elicitation for this approval.
    const answered = (t.answered_inputs ?? []).some((k: string) =>
      k.endsWith(op.approvalId),
    );
    if (owner && !statusOnly && !answered) continue;
    const first = seen.get(`wait:${op.approvalId}`) ?? Date.now();
    seen.set(`wait:${op.approvalId}`, first);
    if (Date.now() - first < 5_000) continue;
    seen.set(`ok:${op.approvalId}`, Date.now());
    const status = await approve(
      owner ? "alice" : "morgan",
      op.approvalId,
      op.digest,
    );
    log("approved", {
      taskId: t.task_id,
      approvalId: op.approvalId,
      by: owner ? "alice (owner, passkey)" : "morgan (manager)",
      status,
    });
  }
};
const timer = setInterval(
  () => void tick().catch((e) => log("tick_failed", { message: String(e) })),
  1_000,
);

const stop = async () => {
  clearInterval(timer);
  await app.end();
  await svc.end();
  await s.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
