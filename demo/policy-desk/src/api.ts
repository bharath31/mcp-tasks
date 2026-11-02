// /sandbox/* API. Every route that acts for a user requires that user's REAL
// Auth0 access token; refusals are machine-readable (see problem.ts).
import {
  appAudience,
  authorityAudience,
  bearer,
  verifyToken,
  type Verified,
} from "./auth0.js";
import {
  MAX_ACTIVE_SANDBOXES,
  BANNER,
  SANDBOX_TTL_MINUTES,
  MAX_PENDING_APPROVALS,
  MAX_OPERATIONS_PER_GENERATION,
  RESOURCE_SERVER,
} from "./env.js";
import {
  loadSandbox,
  sandboxIdFor,
  tenantIdOf,
  type Host,
  type Sandbox,
} from "./host.js";
import { dpopOk } from "./dpop.js";
import { Guardrail, fromGuardrail, json, problem } from "./problem.js";
import { hashIp, limit, LimitExceeded } from "./ratelimit.js";
import {
  DEFAULT_SETTINGS,
  ENVELOPE,
  MAX_POLICY_PUBLISHES_PER_HOUR,
  policySummary,
  validateSettings,
} from "./policy.js";
import { runScenario, SCENARIOS } from "./scenarios.js";
import {
  agentRequest,
  AgentUnavailable,
  type AgentEvent,
  DEFAULT_AGENT_MODEL,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_MESSAGES,
  runAgent,
  type ChatMessage,
} from "./agent.js";
import {
  appendConversation,
  clearConversation,
  loadConversation,
  type ToolStep,
  type Turn,
} from "./conversation.js";
import {
  DEFAULT_POLICY_VERSION,
  ensureSandbox,
  refreshDelegation,
  publishPolicy,
  publishesLastHour,
  seedGeneration,
} from "./seed.js";
import { progress, sandboxAudit, sandboxState, simulate } from "./state.js";
import { listOrders } from "./orders.js";
import {
  agentKeyStatus,
  externalAgentsEnabled,
  issueAgentKey,
  revokeAgentKeys,
} from "./agent-keys.js";
import { adminUsage, isAdmin, recordEvent, touchVisitor } from "./usage.js";

type Call = (req: Request) => Promise<Response>;

const LIMITS = {
  ipRead: [600, 600],
  ipWrite: [60, 600],
  ipReset: [10, 3600],
  ipNewSandbox: [5, 86400],
  userReset: [6, 3600],
  userScenario: [40, 600],
  userPolicy: [20, 3600],
  userSimulate: [20, 600],
  // Each agent turn is several model calls; these keep the Workers AI bill bounded.
  userAgent: [20, 600],
  globalAgent: [300, 86400],
  // Each agent key is one Auth0 M2M token, which the tenant's monthly quota counts.
  userAgentKey: [5, 3600],
  globalAgentKey: [200, 86400],
} as const;

/** What a visitor pastes into their own agent. The key is a bearer token for /mcp and /v1/refunds. */
function agentKeyView(host: Host, key: { token: string; expiresAt: string }) {
  const mcpUrl = `${host.origin}/mcp`;
  return {
    token: key.token,
    tokenType: "Bearer",
    expiresAt: key.expiresAt,
    mcpUrl,
    claudeCode: `claude mcp add --transport http policy-desk ${mcpUrl} --header "Authorization: Bearer ${key.token}"`,
    mcpJson: {
      mcpServers: {
        "policy-desk": {
          type: "http",
          url: mcpUrl,
          headers: { Authorization: `Bearer ${key.token}` },
        },
      },
    },
    note: "Works while your sandbox is active. Your agent acts as the sandbox's refund agent: Task Authority decides each refund, and held refunds wait in Reviews for your passkey.",
  };
}

async function guard(
  host: Host,
  key: string,
  [max, win]: readonly [number, number],
  what: string,
) {
  try {
    await limit(host.conn.db, key, max, win, host.now());
  } catch (e) {
    if (e instanceof LimitExceeded)
      throw new Guardrail(
        429,
        "rate_limited",
        `Too many ${what} requests. Please slow down.`,
        {
          hint: `Try again in ${e.retryAfterSec} seconds.`,
          nextAction: "retry_later",
          retryAfterSec: e.retryAfterSec,
        },
      );
    throw e;
  }
}

async function visitor(host: Host, req: Request): Promise<Verified> {
  const token = bearer(req);
  const v = token
    ? await verifyToken(host.env, token, [authorityAudience(host.env)])
    : null;
  if (!v || !(await dpopOk(host.conn.db, req, token!, v.payload)))
    throw new Guardrail(
      401,
      "invalid_identity",
      "Sign in with Auth0 first. Your access token is missing or invalid.",
      {
        hint: "Request an access token for the Task Authority API audience.",
        nextAction: "sign_in",
      },
    );
  if (v.isClient || !v.orgId)
    throw new Guardrail(
      403,
      "organization_required",
      "The sandbox needs a signed-in person who belongs to the demo organization.",
      {
        hint: "Log in through Universal Login with the organization parameter.",
        nextAction: "sign_in",
      },
    );
  if (host.env.AUTH0_ORG_ID && v.orgId !== host.env.AUTH0_ORG_ID)
    throw new Guardrail(
      403,
      "wrong_organization",
      "Your token is for a different organization than this demo.",
      {
        hint: "Sign in through the demo organization.",
        nextAction: "sign_in",
      },
    );
  return v;
}

async function mySandbox(host: Host, v: Verified): Promise<Sandbox> {
  const s = await loadSandbox(host, await sandboxIdFor(v.sub));
  if (!s)
    throw new Guardrail(
      404,
      "sandbox_not_initialized",
      "Your sandbox does not exist: it was never created, or it expired and was deleted.",
      {
        hint: "Create a new one with POST /sandbox/reset.",
        nextAction: "reset_sandbox",
      },
    );
  if (s.orgId !== v.orgId)
    throw new Guardrail(
      403,
      "wrong_organization",
      "Your token is for a different organization than your sandbox.",
      { nextAction: "sign_in" },
    );
  if (s.expiresAt.getTime() <= host.now())
    throw new Guardrail(
      410,
      "sandbox_expired",
      `Your sandbox expired (${SANDBOX_TTL_MINUTES} minute limit).`,
      {
        hint: "Reset to get a fresh one.",
        nextAction: "reset_sandbox",
      },
    );
  return s;
}

const sandboxView = (s: Sandbox) => ({
  id: s.id,
  orgId: s.orgId,
  generation: s.generation,
  createdAt: s.createdAt,
  expiresAt: s.expiresAt,
  policyVersion: s.policyVersion,
  delegationId: s.delegationId,
  settings: s.policySettings ?? DEFAULT_SETTINGS,
});

function info(host: Host, s?: Sandbox | null) {
  const settings = s?.policySettings ?? DEFAULT_SETTINGS;
  const quorum = host.env.HIGH_VALUE_QUORUM === "2" ? 2 : 1;
  return {
    banner: BANNER,
    paymentsMode: "simulator",
    auth: {
      domain: host.env.AUTH0_DOMAIN ?? null,
      audience: host.env.TASK_AUTHORITY_AUDIENCE ?? null,
      appAudience:
        host.env.APP_AUDIENCE ?? host.env.TASK_AUTHORITY_AUDIENCE ?? null,
      spaClientId: host.env.SPA_CLIENT_ID ?? null,
      organization: host.env.AUTH0_ORG_ID ?? null,
      connection: host.env.LOGIN_CONNECTION ?? "email",
    },
    roles: [
      {
        id: "agent",
        name: "Refund agent",
        description:
          "An LLM on Workers AI that calls the refund app's MCP tools as its own Auth0 machine identity. It never approves.",
        canApprove: false,
      },
      {
        id: "you",
        name: "You",
        description:
          "Your own Auth0 login. You review and approve what the agent requests.",
        canApprove: true,
      },
    ],
    scenarios: SCENARIOS,
    agent: {
      model: host.env.AGENT_MODEL || DEFAULT_AGENT_MODEL,
      available: !!host.env.AI,
      mcpEndpoint: "/mcp",
      /** Whether visitors can connect their own agent with POST /sandbox/agent-key. */
      externalAgents: externalAgentsEnabled(host),
    },
    policy: {
      resourceServer: RESOURCE_SERVER,
      version: s?.policyVersion ?? DEFAULT_POLICY_VERSION,
      settings,
      summary: policySummary(settings, quorum),
      envelope: ENVELOPE,
      defaults: DEFAULT_SETTINGS,
    },
    limits: {
      sandboxTtlMinutes: SANDBOX_TTL_MINUTES,
      maxPendingApprovals: MAX_PENDING_APPROVALS,
      maxOperations: MAX_OPERATIONS_PER_GENERATION,
      maxPolicyPublishesPerHour: MAX_POLICY_PUBLISHES_PER_HOUR,
    },
    endpoints: [
      "GET /sandbox/info",
      "GET /sandbox/me",
      "POST /sandbox/reset",
      "POST /sandbox/agent",
      "GET /sandbox/agent/conversation",
      "DELETE /sandbox/agent/conversation",
      "POST /sandbox/scenario",
      "POST /mcp",
      "GET /sandbox/agent-key",
      "POST /sandbox/agent-key",
      "DELETE /sandbox/agent-key",
      "GET /sandbox/state",
      "GET /sandbox/progress",
      "GET /sandbox/audit",
      "GET /sandbox/policy",
      "PUT /sandbox/policy",
      "POST /sandbox/restore-policy",
      "POST /sandbox/simulate",
    ],
    sandbox: s ? sandboxView(s) : null,
  };
}

export async function sandboxApi(
  host: Host,
  req: Request,
  call: Call,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const ip = await hashIp(host.env, req);
  try {
    const write = req.method !== "GET";
    const publicInfo = path === "/sandbox/info" && req.method === "GET";
    try {
      await guard(
        host,
        `ip:${ip}:${write ? "w" : "r"}`,
        write ? LIMITS.ipWrite : LIMITS.ipRead,
        "sandbox",
      );
    } catch (e) {
      // The public sign-in settings are static. A database hiccup on a cold start must not
      // block the sign-in page; an actual rate-limit refusal still applies.
      if (!publicInfo || e instanceof Guardrail) throw e;
    }

    if (path === "/sandbox/info" && req.method === "GET") {
      // Public: banner, scenarios, envelope. A bearer token adds the caller's sandbox.
      const token = bearer(req);
      const verified = token
        ? await verifyToken(host.env, token, [authorityAudience(host.env)])
        : null;
      const v =
        verified && (await dpopOk(host.conn.db, req, token!, verified.payload))
          ? verified
          : null;
      const s =
        v && !v.isClient
          ? await loadSandbox(host, await sandboxIdFor(v.sub))
          : null;
      return json(info(host, s));
    }
    const v = await visitor(host, req);
    const userKey = (await sandboxIdFor(v.sub)).slice(4);
    const claims = await touchVisitor(host, req, v);

    if (path === "/sandbox/admin/usage" && req.method === "GET") {
      if (!isAdmin(host, v, claims))
        throw new Guardrail(
          403,
          "admin_only",
          "This page is for the demo's operator.",
          {
            hint: "Sign in with an operator account.",
            nextAction: "none",
          },
        );
      const days = Number(url.searchParams.get("days") ?? 14);
      return json(
        await adminUsage(
          host,
          Number.isInteger(days) && days >= 1 && days <= 90 ? days : 14,
        ),
      );
    }

    if (path === "/sandbox/me" && req.method === "GET") {
      const s = await loadSandbox(host, await sandboxIdFor(v.sub));
      const p = v.payload as Record<string, unknown>;
      return json({
        sub: v.sub,
        orgId: v.orgId,
        initialized: !!s,
        sandbox: s ? sandboxView(s) : null,
        sandboxId: await sandboxIdFor(v.sub),
        token: {
          amr: p.amr ?? null,
          acr: p.acr ?? null,
          authTime: p.auth_time ?? null,
          expiresAt:
            typeof p.exp === "number"
              ? new Date(p.exp * 1000).toISOString()
              : null,
          dpopBound: !!(p.cnf as { jkt?: string } | undefined)?.jkt,
        },
      });
    }

    if (path === "/sandbox/reset" && req.method === "POST") {
      await guard(host, `ip:${ip}:reset`, LIMITS.ipReset, "reset");
      await guard(host, `user:${userKey}:reset`, LIMITS.userReset, "reset");
      const exists = await loadSandbox(host, await sandboxIdFor(v.sub));
      // Reviving an expired sandbox takes a slot like creating one does.
      if (!exists || exists.expiresAt.getTime() <= host.now()) {
        await guard(
          host,
          `ip:${ip}:newsbx`,
          LIMITS.ipNewSandbox,
          "sandbox creation",
        );
        const n = await host.conn.db.query(
          "select count(*)::int n from policy_desk.sandboxes where expires_at > now()",
        );
        if (n.rows[0].n >= MAX_ACTIVE_SANDBOXES)
          throw new Guardrail(
            503,
            "sandbox_capacity",
            "The public sandbox is full right now.",
            {
              hint: "Sandboxes are deleted after 15 minutes. Try again shortly.",
              nextAction: "retry_later",
              retryAfterSec: 300,
            },
          );
      }
      // Optional: start with authenticator-app approvals for routine refunds (no passkey device).
      const body = (await req.json().catch(() => null)) as {
        allowAuthenticatorApp?: unknown;
      } | null;
      const s = await ensureSandbox(host, v, ip);
      // A reset keeps the visitor's approval method unless the request names one.
      const out = await seedGeneration(host, s, v, {
        allowAuthenticatorApp:
          typeof body?.allowAuthenticatorApp === "boolean"
            ? body.allowAuthenticatorApp
            : exists?.policySettings?.allowAuthenticatorApp === true,
      });
      await recordEvent(
        host,
        out.sandbox.id,
        exists ? "sandbox_reset" : "sandbox_created",
        { generation: out.sandbox.generation },
      );
      return json({
        sandboxId: out.sandbox.id,
        generation: out.sandbox.generation,
        policyVersion: out.sandbox.policyVersion,
        delegationId: out.sandbox.delegationId,
        orders: out.orders,
        sandbox: sandboxView(out.sandbox),
      });
    }

    const s = await mySandbox(host, v);

    if (path === "/sandbox/state" && req.method === "GET")
      return json({
        ...(await sandboxState(host, s)),
        progress: await progress(host, s),
        policy: sandboxView(s),
      });
    if (path === "/sandbox/progress" && req.method === "GET")
      return json({ sandboxId: s.id, progress: await progress(host, s) });
    if (path === "/sandbox/audit" && req.method === "GET") {
      const op = url.searchParams.get("operationId") ?? "";
      if (!/^[A-Za-z0-9:_\-.]{1,200}$/.test(op))
        throw new Guardrail(
          400,
          "invalid_request",
          "operationId is required.",
          { nextAction: "pick_operation" },
        );
      return json(await sandboxAudit(host, s, op));
    }
    if (path === "/sandbox/policy" && req.method === "GET")
      return json({
        ...info(host, s).policy,
        publishesLastHour: await publishesLastHour(host, s),
        maxPublishesPerHour: MAX_POLICY_PUBLISHES_PER_HOUR,
      });
    if (path === "/sandbox/orders" && req.method === "GET")
      return json({ orders: await listOrders(host.conn.db, tenantIdOf(s)) });

    if (path === "/sandbox/agent-key" && req.method === "GET")
      return json({
        available: externalAgentsEnabled(host),
        mcpUrl: `${host.origin}/mcp`,
        ...(await agentKeyStatus(host, s)),
      });
    if (path === "/sandbox/agent-key" && req.method === "POST") {
      await guard(
        host,
        `user:${userKey}:agentkey`,
        LIMITS.userAgentKey,
        "agent key",
      );
      await guard(host, "global:agentkey", LIMITS.globalAgentKey, "agent key");
      // The key acts under the sandbox's delegation, so make sure it is there to act under.
      const ready = await refreshDelegation(host, s);
      const key = await issueAgentKey(host, ready);
      await recordEvent(host, s.id, "agent_key_issued", {});
      return json(agentKeyView(host, key), 201);
    }
    if (path === "/sandbox/agent-key" && req.method === "DELETE") {
      const revoked = await revokeAgentKeys(host, s);
      return json({ connected: false, revoked });
    }

    if (path === "/sandbox/agent/conversation" && req.method === "GET") {
      const c = await loadConversation(host.conn.db, s);
      return json({ turns: c.turns });
    }
    if (path === "/sandbox/agent/conversation" && req.method === "DELETE") {
      await clearConversation(host.conn.db, s);
      return json({ turns: [] });
    }
    if (path === "/sandbox/agent" && req.method === "POST") {
      const body = agentRequest.safeParse(await req.json().catch(() => null));
      if (!body.success)
        throw new Guardrail(
          400,
          "invalid_request",
          'Send {message: "..."} with what you want the agent to do.',
          { nextAction: "none" },
        );
      const stored = await loadConversation(host.conn.db, s);
      const said: ChatMessage = { role: "user", content: body.data.message };
      const history = [...stored.history, said];
      if (
        history.length > MAX_HISTORY_MESSAGES ||
        JSON.stringify(history).length > MAX_HISTORY_CHARS
      )
        throw new Guardrail(
          413,
          "conversation_too_long",
          "This conversation is too long for the agent.",
          { hint: "Start a new conversation.", nextAction: "new_conversation" },
        );
      await guard(host, `user:${userKey}:agent`, LIMITS.userAgent, "agent");
      await guard(host, "global:agent", LIMITS.globalAgent, "agent");
      const asked: Turn = { role: "user", text: body.data.message };
      const unavailable = (e: AgentUnavailable) =>
        new Guardrail(503, e.code, e.message, {
          hint:
            e.code === "agent_not_configured"
              ? "The operator must add the Workers AI binding to the Worker."
              : "The model may be busy or its daily allowance used up.",
          nextAction: "retry_later",
        });
      const ready = await refreshDelegation(host, s);
      /** Runs the turn and stores it; `emit` sees each model call and MCP exchange as it happens. */
      const turn = async (emit?: (e: AgentEvent) => void) => {
        try {
          const r = await runAgent(host, ready, call, history, emit);
          const answer: Turn = {
            role: "agent",
            text: r.reply,
            steps: r.trace.filter((t): t is ToolStep => t.kind === "tool"),
            model: r.model,
          };
          await appendConversation(
            host.conn.db,
            s,
            { history: [said, ...r.messages], turns: [asked, answer] },
            host.now(),
          );
          return { ...r, turns: [asked, answer] };
        } catch (e) {
          if (e instanceof AgentUnavailable) {
            // The message was not answered, so the model's history does not keep it;
            // the chat does, with the failure, so a reload shows what happened.
            await appendConversation(
              host.conn.db,
              s,
              {
                history: [],
                turns: [
                  asked,
                  { role: "agent", text: e.message, steps: [], failed: true },
                ],
              },
              host.now(),
            );
            throw unavailable(e);
          }
          throw e;
        }
      };
      // The console asks for NDJSON so each model call and MCP exchange shows up as it happens.
      if (
        host.env.AI &&
        req.headers.get("accept")?.includes("application/x-ndjson")
      ) {
        const { readable, writable } = new TransformStream<Uint8Array>();
        const writer = writable.getWriter();
        const enc = new TextEncoder();
        const send = (o: unknown) =>
          writer.write(enc.encode(`${JSON.stringify(o)}\n`)).catch(() => {});
        const started = host.now();
        host.streaming = (async () => {
          try {
            const result = await turn((e) => void send(e));
            await send({
              type: "done",
              result,
              timings: { ...host.conn.timings, totalMs: host.now() - started },
            });
          } catch (e) {
            const g = e instanceof Guardrail ? e : null;
            if (!g)
              console.error(
                JSON.stringify({
                  event: "agent_stream_failed",
                  message: e instanceof Error ? e.message : String(e),
                }),
              );
            await send({
              type: "error",
              status: g?.status ?? 503,
              body: g
                ? await fromGuardrail(g).json()
                : {
                    reason: "dependency_unavailable",
                    message:
                      "Something we depend on is unavailable. Nothing was authorized.",
                    nextAction: "retry_later",
                  },
            });
          } finally {
            await writer.close().catch(() => {});
          }
        })();
        return new Response(readable, {
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
      return json(await turn());
    }

    if (path === "/sandbox/scenario" && req.method === "POST") {
      await guard(
        host,
        `user:${userKey}:scenario`,
        LIMITS.userScenario,
        "scenario",
      );
      const body = (await req.json().catch(() => null)) as {
        id?: string;
      } | null;
      // A sandbox whose first reset failed part-way is still generation 0 with no
      // FGA tuples or delegation; seed it now instead of failing every scenario.
      if (s.generation === 0) {
        await guard(host, `ip:${ip}:reset`, LIMITS.ipReset, "reset");
        await guard(host, `user:${userKey}:reset`, LIMITS.userReset, "reset");
      }
      const ready =
        s.generation === 0
          ? (await seedGeneration(host, s, v)).sandbox
          : await refreshDelegation(host, s);
      const out = body?.id
        ? await runScenario(host, ready, body.id, call, v.token)
        : null;
      if (out) await recordEvent(host, s.id, "scenario_run", { id: body!.id });
      if (!out)
        throw new Guardrail(
          404,
          "unknown_scenario",
          "That scenario does not exist.",
          {
            hint: `Choose one of: ${SCENARIOS.map((x) => x.id).join(", ")}`,
            nextAction: "pick_scenario",
          },
        );
      return json(out);
    }

    if (
      (path === "/sandbox/policy" && req.method === "PUT") ||
      (path === "/sandbox/restore-policy" && req.method === "POST")
    ) {
      await guard(host, `user:${userKey}:policy`, LIMITS.userPolicy, "policy");
      let settings = DEFAULT_SETTINGS;
      let label = "restore";
      if (req.method === "PUT") {
        // A partial edit keeps the sandbox's other settings, not the defaults.
        const parsed = validateSettings(
          await req.json().catch(() => null),
          s.policySettings ?? DEFAULT_SETTINGS,
        );
        if (!parsed.ok)
          throw new Guardrail(422, parsed.issue.code, parsed.issue.message, {
            hint: parsed.issue.hint,
            nextAction: "fix_policy_values",
          });
        settings = parsed.settings;
        label = "edit";
      }
      const version = `refunds.${label}-${host.now().toString(36)}`;
      await publishPolicy(host, s, settings, version, { enforceCap: true });
      await recordEvent(host, s.id, "policy_published", { version });
      return json({
        policy: info(host, (await loadSandbox(host, s.id))!).policy,
        version,
      });
    }

    if (path === "/sandbox/simulate" && req.method === "POST") {
      await guard(
        host,
        `user:${userKey}:sim`,
        LIMITS.userSimulate,
        "simulation",
      );
      const b = (await req.json().catch(() => null)) as {
        thresholdMinor?: unknown;
      } | null;
      const t = b?.thresholdMinor;
      const [lo, hi] = ENVELOPE.agentAutoLimitMinor;
      if (typeof t !== "number" || !Number.isInteger(t) || t < lo || t > hi)
        throw new Guardrail(
          422,
          "policy_value_out_of_range",
          `thresholdMinor must be a whole number between ${lo} and ${hi}.`,
          { hint: "Amounts are in cents.", nextAction: "fix_policy_values" },
        );
      const sim = await simulate(host, s, t);
      await recordEvent(host, s.id, "simulation", { thresholdMinor: t });
      return json(sim);
    }

    return problem(404, "not_found", "Unknown sandbox endpoint.", {
      nextAction: "none",
    });
  } catch (e) {
    if (e instanceof Guardrail) return fromGuardrail(e);
    throw e;
  }
}
