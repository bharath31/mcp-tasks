// The ONLY module that talks to the network. Calls carry the visitor's real Auth0
// access token (DPoP-bound when configured). Wire shapes are mapped onto types.ts.
import * as activity from "./activity";
import * as auth from "./auth";
import {
  ApiError,
  type AgentEvent,
  type AgentKey,
  type AgentKeyStatus,
  type AgentTurn,
  type Api,
  type ChatTurn,
  type ApprovalItem,
  type AuditEvent,
  type DecisionItem,
  type DecisionResult,
  type Info,
  type Me,
  type Operation,
  type PolicyView,
  type Progress,
} from "./types";

type Json = Record<string, any>; // wire payloads, validated structurally where used

export const PENDING_KEY = "policy-desk.pending-decision";

type Opts = {
  method?: string;
  body?: unknown;
  allowError?: boolean;
  headers?: Record<string, string>;
  /** Send the token Auth0 just issued for a step-up, not the sign-in token. */
  stepUpToken?: boolean;
};
type Reply = { status: number; body: Json; headers: Headers; text: string };

/** Identical GETs already in flight share one request (the rail and a view often ask together). */
const inflight = new Map<string, Promise<Reply>>();

function call(path: string, opts: Opts = {}): Promise<Reply> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  if (method !== "GET" || opts.headers) return send(path, method, opts);
  const key = `${path}|${opts.allowError ? 1 : 0}`;
  const hit = inflight.get(key);
  if (hit) return hit;
  const p = send(path, method, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function networkError(e: unknown) {
  const m = String((e as Error)?.message ?? e);
  if (m.includes(auth.STEP_UP_INCOMPLETE))
    return new ApiError(
      "Auth0 did not finish the passkey step, so nothing was approved. The refund is still waiting: press Approve again.",
      401,
      auth.STEP_UP_INCOMPLETE,
    );
  if (
    /login_required|missing_refresh_token|consent_required|invalid_grant|expired/i.test(
      m,
    )
  )
    return new ApiError(
      "Your Auth0 session has ended.",
      401,
      "session_expired",
    );
  return new ApiError(
    "The sandbox is unreachable. Check your connection and retry.",
    0,
    "network",
  );
}

async function send(path: string, method: string, opts: Opts): Promise<Reply> {
  let res: Response;
  const act = activity.begin(method, path);
  try {
    res = await auth.authedFetch(
      path,
      {
        method,
        headers: {
          ...(opts.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      },
      { stepUpToken: opts.stepUpToken },
    );
  } catch (e) {
    activity.end(act, { failed: true });
    throw networkError(e);
  }
  activity.end(act, { status: res.status, headers: res.headers });
  // A write makes any read already in flight stale; the next read goes to the server.
  if (method !== "GET") inflight.clear();
  const text = await res.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    /* non-JSON body */
  }
  if (!res.ok && !opts.allowError) {
    const e = errorFields(body, res.status);
    const retry =
      Number(res.headers.get("retry-after") ?? body.retryAfterSec ?? 0) ||
      undefined;
    throw new ApiError(
      e.message,
      res.status,
      e.reason,
      retry,
      e.hint,
      e.nextAction,
    );
  }
  return { status: res.status, body, headers: res.headers, text };
}

/** Sandbox refusals carry {reason, message, hint, nextAction}; service refusals carry {code, message, details.reason}. */
function errorFields(body: Json, status: number) {
  const err = body.error;
  const reason: string | undefined =
    body.reason ??
    body.details?.reason ??
    body.code ??
    (typeof err === "string" ? err : (err?.details?.reason ?? err?.code));
  const message: string =
    body.message ?? err?.message ?? reason ?? `HTTP ${status}`;
  return {
    reason,
    message,
    hint: body.hint as string | undefined,
    nextAction: body.nextAction as string | undefined,
  };
}

let infoCache: Info | undefined;
let infoRaw: Json | undefined;
let me: Me | undefined;

type State = { orders: Json[]; operations: Json[]; budget?: Json };
async function rawState(): Promise<State> {
  const b = (await call("/sandbox/state")).body;
  return {
    orders: b.orders ?? [],
    operations: b.operations ?? [],
    budget: b.budget,
  };
}

function mapOp(o: Json, orders: Json[]): Operation {
  const order = orders.find((x) => x.orderId === o.orderId);
  const actor = o.actor as Json | undefined;
  return {
    id: o.id,
    state: o.outcomeStatus ?? "unknown",
    action: o.action,
    resource: o.orderId ? `order/${o.orderId}` : "n/a",
    amountMinor: o.amountMinor,
    currency: o.currency ?? "USD",
    customer: o.customer ?? order?.customer,
    item: order?.item,
    reason: o.reason,
    ruleIds: o.ruleIds,
    requester:
      actor?.type === "agent" ? "Refund agent" : String(actor?.id ?? "unknown"),
    tier: o.tier ?? undefined,
    assurance:
      o.assurance === "per_operation" || o.assurance === "session_mfa"
        ? o.assurance
        : undefined,
    factors: Array.isArray(o.factors) ? (o.factors as string[]) : undefined,
    decision: o.decision,
    reasonCode: o.reasonCode,
    policyVersion: o.policyVersion,
    createdAt: o.createdAt,
    digest: o.digest,
    approvalId: o.approval?.id,
    quorum: o.approval
      ? { required: o.approval.quorum, have: o.approval.approvals }
      : undefined,
  };
}

function actorChain(a: Json | undefined): string[] {
  if (!a) return [];
  const chain = [`${a.type ?? "actor"} ${a.id ?? a.sub ?? ""}`.trim()];
  const behind = a.onBehalfOf ?? a.delegator ?? a.act?.sub ?? a.act?.id;
  if (behind) chain.push(`on behalf of ${behind}`);
  return chain;
}

const KNOWN_REASONS = [
  "factor_not_satisfied",
  "mfa_required",
  "step_up_stale_or_before_request",
  "challenge_not_bound_to_operation",
  "dpop_required",
  "token_replayed",
  "token_id_required",
  "reviewer_session_idle",
  "reviewer_velocity_exceeded",
  "initiator_cannot_approve",
  "approver_ineligible",
  "digest_mismatch",
  "operation_changed",
] as const;

const REASON_TEXT: Record<string, string> = {
  factor_not_satisfied:
    "This refund needs a passkey or security key, and the Auth0 check you just finished ended on a code instead. Nothing was approved. If Auth0 just helped you add a passkey, press Approve again: this time Auth0 asks for that passkey only.",
  mfa_required:
    "This decision needs a fresh passkey check and the token sent had none. Nothing was approved. Press Approve again and confirm with your passkey when Auth0 asks.",
  webauthn_unavailable:
    "This browser cannot use passkeys or security keys, so it cannot approve this refund. Nothing was sent. Open the sandbox in a current browser (Chrome, Safari, Edge or Firefox) on a device that supports passkeys. You can still reject from here.",
  step_up_stale_or_before_request:
    "Your authentication is older than this tier allows, or it happened before this approval was requested. Authenticate again, then approve.",
  challenge_not_bound_to_operation:
    "The Auth0 sign-in was not tied to this approval, so the service will not accept it. Approve again so a fresh challenge is created for this exact refund.",
  dpop_required:
    "The service requires a sender-constrained (DPoP) token. This browser's token is not DPoP-bound; check that DPoP is enabled for the sandbox's Auth0 application.",
  token_replayed:
    "That sign-in was already used for a decision. Each high-value approval needs its own fresh sign-in.",
  token_id_required:
    "Your token has no unique id, which high-value approvals require.",
  reviewer_session_idle:
    "Your review session was idle for too long. Sign in again to continue.",
  reviewer_velocity_exceeded:
    "You have decided too many approvals this hour. The limit protects against rubber-stamping; try again later.",
  initiator_cannot_approve:
    "You started this operation, so you cannot approve it.",
  approver_ineligible:
    "Policy does not make you an eligible approver for this operation.",
  digest_mismatch:
    "The refund changed after you opened it, so your approval no longer matches. Reload the queue and review it again.",
  operation_changed:
    "The refund changed after you opened it, so your approval no longer matches. Reload the queue and review it again.",
};

function reasonOf(text: string, fallback?: string): string | undefined {
  return KNOWN_REASONS.find((r) => text.includes(r)) ?? fallback;
}

/** High-value approval: the service issues a challenge bound to this approval, digest, reviewer and DPoP key;
 *  Auth0 then re-authenticates the reviewer (WebAuthn) and stamps the challenge into the token. */
async function startHighValue(item: DecisionItem): Promise<DecisionResult> {
  if (
    !item.appCodeAccepted &&
    typeof window !== "undefined" &&
    !("PublicKeyCredential" in window)
  )
    return {
      ok: false,
      status: 400,
      code: "webauthn_unavailable",
      message: REASON_TEXT.webauthn_unavailable!,
    };
  const c = await call(
    `/v1/approval-requests/${encodeURIComponent(item.approvalId)}/challenge`,
    { body: {}, allowError: true },
  );
  if (c.status >= 400 || !c.body.challenge) {
    const ef = errorFields(c.body, c.status);
    const reason = reasonOf(c.text, ef.reason);
    return {
      ok: false,
      status: c.status,
      code: reason,
      message:
        REASON_TEXT[reason ?? ""] ??
        (/DPoP/i.test(c.text)
          ? "The service needs a DPoP-bound token to issue an approval challenge. " +
            REASON_TEXT.dpop_required
          : ef.message),
    };
  }
  try {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ kind: "decision", items: [item] }),
    );
  } catch {
    /* without storage the visitor presses Approve again after returning */
  }
  // No max_age: the Auth0 session already holds the email sign-in, so the reviewer goes
  // straight to the passkey. The Action forces a fresh WebAuthn factor and the service
  // checks that factor's own time against this challenge.
  await auth.stepUp(
    { max_age: null },
    { section: "reviews", focusOp: item.operationId },
    {
      task_authority_challenge: String(c.body.challenge),
      // Offer only what the tier accepts: the service refuses any other factor anyway.
      task_authority_factor: item.appCodeAccepted
        ? "webauthn_or_otp"
        : "webauthn",
    },
  );
  return {
    ok: false,
    status: 302,
    message: item.appCodeAccepted
      ? "Sending you to Auth0 to confirm with your passkey or authenticator app. Nothing set up yet? Auth0 helps you add one first."
      : "Sending you to Auth0 to confirm with your passkey. No passkey yet? Auth0 helps you create one first.",
    redirecting: true,
  };
}

async function decide(
  items: DecisionItem[],
  fromResume = false,
): Promise<DecisionResult> {
  const first = items[0]!;
  if (
    !fromResume &&
    items.length === 1 &&
    first.highValue &&
    first.decision === "approve"
  )
    return startHighValue(first);
  const res = await call(
    `/v1/approval-requests/${encodeURIComponent(first.approvalId)}/decisions`,
    {
      body: {
        decision: first.decision,
        operationDigest: first.digest,
        ...(first.reason ? { reason: first.reason } : {}),
      },
      allowError: true,
      stepUpToken: fromResume,
    },
  );
  queueCache = undefined;
  if (res.status < 400)
    return {
      ok: true,
      status: res.status,
      operationId: first.operationId,
      decision: first.decision,
      message: `${first.decision === "approve" ? "Approved" : "Rejected"} the operation. The decision is bound to the digest you reviewed.`,
    };
  const ef = errorFields(res.body, res.status);
  const reason = reasonOf(res.text, ef.reason);
  const message =
    REASON_TEXT[reason ?? ""] ??
    (ef.hint ? `${ef.message} ${ef.hint}` : ef.message);
  const challenge = auth.parseChallenge(res.headers.get("www-authenticate"));
  const needsStepUp =
    !fromResume &&
    (res.status === 401 ||
      Boolean(challenge) ||
      reason === "mfa_required" ||
      reason === "step_up_stale_or_before_request");
  if (needsStepUp) {
    // Real re-authentication with Auth0, then replay this decision on return.
    try {
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify({ kind: "decision", items }),
      );
    } catch {
      /* the visitor repeats the click after returning */
    }
    await auth.stepUp(challenge ?? {}, { section: "reviews" });
    return {
      ok: false,
      status: res.status,
      code: reason,
      message: "Sending you to Auth0 to confirm it is you…",
      redirecting: true,
    };
  }
  return { ok: false, status: res.status, code: reason, message };
}

let queueCache: { at: number; p: Promise<ApprovalItem[]> } | undefined;

async function loadQueue(): Promise<ApprovalItem[]> {
  const [list, st, who] = await Promise.all([
    call("/v1/approval-requests?status=pending"),
    rawState(),
    live.me(),
  ]);
  return ((list.body.approvals ?? []) as Json[]).map((a): ApprovalItem => {
    const wire = st.operations.find(
      (o) => o.approval?.id === a.id || o.id === a.operationId,
    );
    const args = (a.operation?.arguments ?? {}) as Json;
    const op: Operation = wire
      ? mapOp(wire, st.orders)
      : {
          id: a.operationId,
          state: "pending_approval",
          action: a.operation?.action ?? "unknown",
          resource: a.operation?.resource ?? "n/a",
          amountMinor: args.amountMinor,
          currency: args.currency,
          reason: args.reason,
          requester: "unknown",
          createdAt: a.requestedAt,
          digest: a.operationDigest,
        };
    const tier = op.tier ?? "routine";
    return {
      id: a.id,
      operation: op,
      tier,
      digest: a.operationDigest,
      expiresAt: a.expiresAt,
      // A lapsed claim is free: show it as unclaimed rather than "claimed by you" until a time already past.
      lease:
        a.lease && Date.parse(a.lease.expiresAt) > Date.now()
          ? {
              mine: a.lease.reviewerId === who.sub,
              expiresAt: a.lease.expiresAt,
            }
          : undefined,
      // The policy snapshot decides; a missing snapshot fails closed to a fresh WebAuthn step-up.
      assurance: op.assurance ?? "per_operation",
      appCodeAccepted: Boolean(op.factors?.includes("otp")),
    };
  });
}

export const live: Api = {
  async me() {
    if (me) return me;
    // The ID token lets the operator's usage page show who signed in (email only).
    const idt = await auth.idToken();
    const b = (
      await call("/sandbox/me", idt ? { headers: { "x-id-token": idt } } : {})
    ).body;
    const u = await auth.user();
    me = {
      sub: b.sub ?? u?.sub ?? "unknown",
      name: u?.name ?? u?.email ?? "Reviewer",
      email: u?.email,
      sandboxId: b.sandboxId,
      initialized: Boolean(b.initialized),
      token: b.token
        ? {
            amr: (b.token.amr ?? []) as string[],
            dpopBound: Boolean(b.token.dpopBound),
            authTime: b.token.authTime,
          }
        : undefined,
    };
    return me;
  },
  async info() {
    if (infoCache) return infoCache;
    const i = (await call("/sandbox/info")).body;
    const agent = ((i.roles ?? []) as Json[]).find((r) => r.id === "agent");
    infoCache = {
      banner: i.banner,
      limits: {
        maxPending: i.limits?.maxPendingApprovals,
        maxOperations: i.limits?.maxOperations,
        maxPolicyPublishesPerHour: i.limits?.maxPolicyPublishesPerHour,
        sandboxTtlMinutes: i.limits?.sandboxTtlMinutes,
        sandboxExpiresAt: i.sandbox?.expiresAt,
      },
      agent: {
        name: agent?.name ?? "Refund agent",
        subject: "Auth0 machine-to-machine client",
        role: agent?.description,
        model: i.agent?.model,
        available: i.agent?.available !== false,
      },
      resourceServer: i.policy?.resourceServer ?? "",
    };
    return infoCache;
  },
  async agent(message, onEvent) {
    queueCache = undefined;
    const act = activity.begin("POST", "/sandbox/agent");
    let res: Response;
    try {
      res = await auth.authedFetch("/sandbox/agent", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson",
        },
        body: JSON.stringify({ message }),
      });
    } catch (e) {
      activity.end(act, { failed: true });
      throw networkError(e);
    }
    if (
      !res.ok ||
      !res.body ||
      !/ndjson/.test(res.headers.get("content-type") ?? "")
    ) {
      activity.end(act, { status: res.status, headers: res.headers });
      const text = await res.text();
      let body: Json = {};
      try {
        body = text ? (JSON.parse(text) as Json) : {};
      } catch {
        /* non-JSON body */
      }
      if (res.ok) return body as AgentTurn;
      const e = errorFields(body, res.status);
      throw new ApiError(
        e.message,
        res.status,
        e.reason,
        undefined,
        e.hint,
        e.nextAction,
      );
    }
    // NDJSON: one event per line while the model and MCP calls run, then "done" or "error".
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({
        value: undefined,
        done: true as const,
      }));
      if (value) buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line) as
          | AgentEvent
          | { type: "done"; result: AgentTurn; timings?: Json }
          | { type: "error"; status: number; body: Json };
        if (ev.type === "done") {
          inflight.clear();
          activity.endStream(act, 200, ev.timings);
          return ev.result;
        }
        if (ev.type === "error") {
          activity.endStream(act, ev.status);
          const e = errorFields(ev.body, ev.status);
          throw new ApiError(
            e.message,
            ev.status,
            e.reason,
            undefined,
            e.hint,
            e.nextAction,
          );
        }
        onEvent?.(ev);
      }
      if (done) break;
    }
    activity.end(act, { status: 0, failed: true });
    throw new ApiError(
      "The connection closed before the agent finished. Ask it to check on the refund.",
      0,
      "network",
    );
  },
  async conversation() {
    return ((await call("/sandbox/agent/conversation")).body.turns ??
      []) as ChatTurn[];
  },
  async clearConversation() {
    await call("/sandbox/agent/conversation", { method: "DELETE" });
  },
  async state() {
    const st = await rawState();
    const b = st.budget;
    return {
      operations: st.operations.map((o) => mapOp(o, st.orders)).reverse(),
      budget: b
        ? {
            usedMinor: b.usedMinor,
            maxMinor: b.maxMinor,
            usedCount: b.usedCount,
            maxCount: b.maxCount,
          }
        : undefined,
    };
  },
  async progress() {
    const b = (await call("/sandbox/progress")).body;
    return (b.progress ?? b) as Progress;
  },
  async audit(operationId): Promise<AuditEvent[]> {
    const b = (
      await call(
        `/sandbox/audit?operationId=${encodeURIComponent(operationId)}`,
      )
    ).body;
    return ((b.events ?? []) as Json[]).map((e) => ({
      at: e.createdAt ?? e.at,
      type: e.type,
      actorChain: [
        ...(e.policyActor
          ? [
              `${e.policyActor.type ?? "actor"} ${e.policyActor.id ?? ""}`.trim(),
            ]
          : []),
        ...(e.actor
          ? [
              `${e.actor.kind ?? e.actor.type ?? "actor"} ${e.actor.id ?? ""}`.trim(),
            ]
          : []),
        ...(e.act ? [`acting: ${e.act.sub ?? JSON.stringify(e.act)}`] : []),
      ],
      policyVersion: e.policyVersion,
      ruleIds: e.ruleIds,
      detail:
        [e.decision, e.reasonCode].filter(Boolean).join(" · ") || undefined,
      reviewerReason:
        typeof e.evaluation?.reviewerReason === "string"
          ? e.evaluation.reviewerReason
          : undefined,
    }));
  },
  queue(): Promise<ApprovalItem[]> {
    // A prefetch from the last few seconds is as good as a fresh read.
    if (queueCache && Date.now() - queueCache.at < 5000) {
      const p = queueCache.p;
      queueCache = undefined;
      return p;
    }
    return loadQueue();
  },
  prefetchQueue() {
    const p = loadQueue();
    p.catch(() => (queueCache = undefined));
    queueCache = { at: Date.now(), p };
  },
  async lease(id) {
    queueCache = undefined;
    await call(`/v1/approval-requests/${encodeURIComponent(id)}/lease`, {
      body: {},
    });
  },
  decide: (items) => decide(items),
  async resumePending() {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(PENDING_KEY);
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      return undefined;
    }
    if (!raw) return undefined;
    const p = JSON.parse(raw) as { kind: "decision"; items: DecisionItem[] };
    if (p.kind !== "decision") return undefined;
    return { kind: "decision", result: await decide(p.items, true) };
  },
  async policy(): Promise<PolicyView> {
    const info = await live.info();
    const raw = (await call("/sandbox/policy")).body;
    const p = (raw.policy ?? raw) as Json;
    let document: unknown;
    try {
      const d = await call(
        `/v1/policies/${encodeURIComponent(info.resourceServer)}`,
        { allowError: true },
      );
      if (d.status < 400)
        document = ((d.body.versions ?? []) as Json[]).find(
          (v) => v.active,
        )?.document;
    } catch {
      /* the summary is the readable form */
    }
    return {
      resourceServer: info.resourceServer,
      version: String(p.version ?? ""),
      settings: p.settings,
      summary: (p.summary ?? []) as PolicyView["summary"],
      envelope: p.envelope,
      document,
      publishes:
        typeof raw.publishesLastHour === "number" &&
        typeof raw.maxPublishesPerHour === "number"
          ? { used: raw.publishesLastHour, max: raw.maxPublishesPerHour }
          : undefined,
    };
  },
  async savePolicy(change) {
    const r = await call("/sandbox/policy", { method: "PUT", body: change });
    infoCache = undefined;
    return String(r.body.version ?? r.body.policy?.version ?? "");
  },
  async restorePolicy() {
    const r = await call("/sandbox/restore-policy", { body: {} });
    infoCache = undefined;
    return String(r.body.version ?? r.body.policy?.version ?? "");
  },
  async simulate(thresholdMinor) {
    const b = (await call("/sandbox/simulate", { body: { thresholdMinor } }))
      .body;
    return {
      considered: b.considered ?? 0,
      changed: b.changed ?? 0,
      rows: (b.rows ?? []) as Json[] as never,
    };
  },
  async agentKey() {
    const b = (await call("/sandbox/agent-key")).body;
    return {
      available: b.available !== false,
      connected: Boolean(b.connected),
      mcpUrl: String(b.mcpUrl ?? `${location.origin}/mcp`),
      expiresAt: b.expiresAt ?? undefined,
      lastUsedAt: b.lastUsedAt ?? undefined,
    } satisfies AgentKeyStatus;
  },
  async connectAgent() {
    const b = (await call("/sandbox/agent-key", { body: {} })).body;
    return {
      token: String(b.token),
      expiresAt: String(b.expiresAt),
      mcpUrl: String(b.mcpUrl),
      claudeCode: String(b.claudeCode),
      mcpJson: b.mcpJson,
    } satisfies AgentKey;
  },
  async disconnectAgent() {
    await call("/sandbox/agent-key", { method: "DELETE" });
  },
  async reset(opts = {}) {
    queueCache = undefined;
    await call("/sandbox/reset", { body: opts });
    infoCache = undefined;
    me = undefined;
  },
  signOut: () => auth.logout() as Promise<void>,
};

export async function getApi(): Promise<Api> {
  return live;
}
