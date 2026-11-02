import { connectPanel } from "./connect";
import type { Ctx } from "./ctx";
import {
  ago,
  badge,
  chip,
  clear,
  empty,
  fold,
  h,
  json,
  money,
  panel,
  put,
  secs,
  stateChip,
} from "./dom";
import { mountError } from "./ui";
import { assistantReplyForDisplay, safeApprovalHref } from "./approval-link";
import type {
  AgentBeat,
  AgentEvent,
  AgentStep,
  AgentToolStep,
  Budget,
  ChatTurn,
  McpExchange,
  Operation,
} from "./types";

const LABEL = {
  allow: "Allowed",
  approve: "Approval required",
  deny: "Denied",
  step_up: "Step-up required",
} as const;

export function decisionBadge(o: keyof typeof LABEL) {
  return badge(o === "approve" ? "approve" : o, LABEL[o], o);
}

type Beat = AgentBeat;

/**
 * The conversation lives in this module, not in the Agent view, so switching sections
 * (which remounts the view) keeps it and a reply that arrives meanwhile is not lost.
 * The server stores it per sandbox, so a reload or another browser tab shows it too;
 * sessionStorage only paints the last copy while the server's is on its way.
 */
const chat = {
  turns: [] as ChatTurn[],
  sandboxId: undefined as string | undefined,
  /** The server's copy has been read (or the last attempt failed). */
  loaded: false,
  loadFailed: false,
  busy: false,
  /** Bumped on every local change, so a slower server load never overwrites it. */
  version: 0,
};
/** The mounted Agent view, if any: redraws it and refreshes its side panel. */
let view:
  { draw(): void; drawLive(): void; settled(): Promise<void> } | undefined;
/** The turn in progress: one line per model call and MCP call, streamed by the server. */
let live: Beat[] = [];
let liveStart = 0;

function lastOf(kind: Beat["kind"]) {
  for (let i = live.length - 1; i >= 0; i--)
    if (live[i]!.kind === kind) return i;
  return -1;
}

function onEvent(e: AgentEvent) {
  const now = performance.now();
  if (e.type === "model_start")
    live.push({
      kind: "model",
      label: `Model call ${e.n}`,
      detail: "thinking",
      startedAt: now,
    });
  else if (e.type === "model_done" && e.step.kind === "model") {
    const i = lastOf("model");
    if (i >= 0) live[i] = modelBeat(e.step);
  } else if (e.type === "tool_start")
    live.push({
      kind: "tool",
      label: "MCP tools/call",
      detail: e.tool,
      startedAt: now,
    });
  else if (e.type === "tool_done") {
    const i = lastOf("tool");
    if (i >= 0) live[i] = toolBeat(e.step);
  }
  view?.drawLive();
}

const cacheKey = () => `pd.agent.chat.v2:${chat.sandboxId ?? ""}`;
function cached(): ChatTurn[] {
  try {
    const t = JSON.parse(sessionStorage.getItem(cacheKey()) ?? "null");
    if (Array.isArray(t)) return t as ChatTurn[];
  } catch {
    /* nothing cached */
  }
  return [];
}
function save() {
  try {
    sessionStorage.setItem(cacheKey(), JSON.stringify(chat.turns));
  } catch {
    /* the server keeps the conversation anyway */
  }
}

/** Remembers each refund task's MCP exchanges so Audit can show them. */
function recordRuns(ctx: Ctx, turns: ChatTurn[], fresh = false) {
  if (fresh) ctx.runs.clear();
  for (const t of turns)
    if (t.role === "agent")
      for (const s of t.steps) {
        if (!s.task) continue;
        const prev = ctx.runs.get(s.task.taskId);
        ctx.runs.set(
          s.task.taskId,
          prev ? { ...s, exchanges: [...prev.exchanges, ...s.exchanges] } : s,
        );
      }
}

/** Drops this page's copy of the conversation (the sandbox was reset). */
export function forgetConversation() {
  try {
    sessionStorage.removeItem(cacheKey());
  } catch {
    /* nothing cached */
  }
  chat.turns = [];
  chat.loaded = false;
  chat.version++;
}

/** Loads the stored conversation once per page; Audit uses it for the MCP exchanges. */
export async function loadConversation(ctx: Ctx) {
  const sandboxId = ctx.me.sandboxId;
  if (chat.sandboxId !== sandboxId) {
    chat.sandboxId = sandboxId;
    chat.loaded = false;
    chat.turns = cached();
    chat.version++;
    recordRuns(ctx, chat.turns, true);
  }
  if (chat.loaded || chat.busy) return;
  const at = chat.version;
  try {
    const turns = await ctx.api.conversation();
    if (at !== chat.version || chat.sandboxId !== sandboxId) return;
    chat.turns = turns;
    chat.loaded = true;
    chat.loadFailed = false;
    recordRuns(ctx, turns, true);
    save();
  } catch {
    // Keep what this tab has; the next visit to the Agent view tries again.
    chat.loadFailed = true;
  }
  view?.draw();
}

async function ask(ctx: Ctx, raw: string) {
  const text = raw.trim();
  if (!text || chat.busy || !ctx.info.agent.available) return;
  chat.busy = true;
  chat.version++;
  live = [];
  liveStart = performance.now();
  const mine: ChatTurn = { role: "user", text };
  chat.turns.push(mine);
  save();
  view?.draw();
  try {
    const r = await ctx.api.agent(text, onEvent);
    // This page keeps the full timeline (model calls too); the server stores tool steps.
    const reply = r.turns.find((t) => t.role === "agent");
    if (reply?.role === "agent") {
      reply.beats = beatsOf(r.trace);
      reply.ms = performance.now() - liveStart;
    }
    // A sandbox reset while the agent worked drops the message from this page.
    const at = chat.turns.indexOf(mine);
    if (at >= 0) {
      chat.turns.splice(at, 1, ...r.turns);
      recordRuns(ctx, r.turns);
    }
    // A refund now waiting for a person: load the review queue before the visitor goes there.
    if (
      r.trace.some(
        (s) =>
          s.kind === "tool" &&
          s.task?.decision?.decision === "approval_required",
      )
    )
      ctx.api.prefetchQueue();
  } catch (e) {
    const err = e as Error & { hint?: string };
    chat.turns.push({
      role: "agent",
      text: [err.message, err.hint].filter(Boolean).join(" "),
      steps: [],
      failed: true,
    });
  }
  chat.busy = false;
  chat.version++;
  save();
  view?.draw();
  ctx.changed();
  await view?.settled();
}

/** Prompts a support rep might type. The agent reads the real orders to act on them. */
const SUGGESTIONS: { guide?: string; label: string; text: string }[] = [
  {
    guide: "small",
    label: "Refund Dana $40",
    text: "Dana Whitfield's trail jacket arrived with a torn sleeve. Refund her $40.",
  },
  {
    guide: "large",
    label: "Refund Mei's $139 keyboard",
    text: "Mei Tanaka's keyboard was dead on arrival. Refund it in full.",
  },
  {
    label: "Refund Sofia $1,500",
    text: "Sofia Alvarez's standing desk arrived cracked. Refund $1,500 of it.",
  },
  {
    label: "Check waiting refunds",
    text: "Check on the refunds you have waiting.",
  },
];

/** Plain-language state of one tool call, from what the MCP server returned. */
function outcomeOf(s: AgentToolStep): {
  kind: "allow" | "approve" | "deny" | "info";
  label: string;
  detail?: string;
} {
  const t = s.task;
  if (t) {
    if (t.status === "completed") return { kind: "allow", label: "Refunded" };
    if (t.status === "failed")
      return {
        kind: "deny",
        label: "Refused",
        detail: t.statusMessage ?? t.decision?.reasonCode ?? undefined,
      };
    if (t.status === "cancelled") return { kind: "deny", label: "Cancelled" };
    if (t.decision?.decision === "approval_required")
      return {
        kind: "approve",
        label: "Waiting for approval",
        detail: t.decision.tier ? t.decision.tier.replace("_", " ") : undefined,
      };
    return { kind: "info", label: t.status.replace("_", " ") };
  }
  if (s.isError) return { kind: "deny", label: "Error" };
  return { kind: "info", label: "Done" };
}

function toolLine(s: AgentToolStep): string {
  const a = s.arguments ?? {};
  if (s.tool === "request_refund")
    return `${money(Number(a.amountMinor) || undefined)} on ${String(a.orderId ?? "?")}`;
  if (s.tool === "get_order") return String(a.orderId ?? "");
  if (s.tool === "get_task") return String(a.taskId ?? "");
  return "";
}

function modelBeat(step: Extract<AgentStep, { kind: "model" }>): Beat {
  return {
    kind: "model",
    label: step.toolCalls.length
      ? "Model chose a tool"
      : "Model wrote the reply",
    detail: step.toolCalls.length ? step.toolCalls.join(", ") : undefined,
    ms: step.ms,
  };
}

function toolBeat(step: AgentToolStep): Beat {
  const o = outcomeOf(step);
  return {
    kind: "tool",
    label: `MCP ${step.exchanges.map((x) => x.request.method).join(" → ") || "tools/call"}`,
    detail: [step.tool, toolLine(step), o.kind === "info" ? "" : o.label]
      .filter(Boolean)
      .join(" · "),
    ms: step.ms,
    outcome: o.kind,
  };
}

/** Rebuilds the timeline of a finished turn from its trace (turns saved before streaming have none). */
function beatsOf(trace: AgentStep[]): Beat[] {
  return trace.map((s) => (s.kind === "model" ? modelBeat(s) : toolBeat(s)));
}

/** The step-by-step account of a turn: every model call and MCP exchange, with its time. */
function timeline(beats: Beat[], live: boolean): HTMLElement {
  return h(
    "ol",
    { class: `beats${live ? " live" : ""}` },
    ...beats.map((b) =>
      h(
        "li",
        {
          class: `beat ${b.kind} ${b.ms === undefined ? "running" : "done"} ${b.outcome ?? ""}`,
        },
        h("span", { class: "beat-dot", "aria-hidden": "true" }),
        h("span", { class: "beat-label" }, b.label),
        b.detail ? h("span", { class: "beat-detail" }, b.detail) : null,
        h("span", { class: "spacer" }),
        h(
          "span",
          {
            class: "beat-ms mono",
            ...(b.ms === undefined && b.startedAt
              ? { "data-since": String(b.startedAt) }
              : {}),
          },
          b.ms === undefined ? "" : secs(b.ms),
        ),
      ),
    ),
  );
}

/** The JSON-RPC exchanges of one tool call, exactly as sent and received. */
export function mcpExchanges(s: AgentToolStep): HTMLElement {
  return h(
    "div",
    { class: "wire" },
    ...s.exchanges.map((x: McpExchange) =>
      h(
        "div",
        { class: "wire-x" },
        h(
          "div",
          { class: "wire-h" },
          h("span", { class: "mono" }, `POST /mcp · ${x.request.method}`),
          chip(`HTTP ${x.status}`, x.status < 400 ? "" : "bad"),
        ),
        h(
          "pre",
          {},
          json({ method: x.request.method, params: x.request.params }),
        ),
        h("pre", { class: "res" }, json(x.response)),
      ),
    ),
    s.exchanges.length
      ? null
      : h(
          "p",
          { class: "dim" },
          "Nothing was sent: the model asked for a tool the MCP server does not offer.",
        ),
  );
}

function toolCard(s: AgentToolStep, ctx: Ctx): HTMLElement {
  // The latest state of the task, not this turn's snapshot: a reviewer may have decided since.
  const now = s.task
    ? (ctx.runs.get(s.task.taskId)?.task ?? s.task)
    : undefined;
  const o = outcomeOf(now ? { ...s, task: now } : s);
  // The call to action sits outside the collapsed card, and only while the refund still waits.
  const waiting =
    o.kind === "approve" &&
    now?.status === "working" &&
    now.decision?.decision === "approval_required";
  const card = h(
    "details",
    { class: `tool ${o.kind}`, "data-key": `tool:${s.callId}` },
    h(
      "summary",
      {},
      h("span", { class: "tool-dot", "aria-hidden": "true" }),
      h("span", { class: "tool-name mono" }, s.tool),
      h("span", { class: "tool-args" }, toolLine(s)),
      h("span", { class: "spacer" }),
      badge(o.kind === "info" ? "plain" : o.kind, o.label),
    ),
    o.detail ? h("p", { class: "tool-detail" }, o.detail) : null,
    mcpExchanges(s),
  );
  if (!waiting) return card;
  const auth0Approval = now?.decision?.reasonCode === "auth0_passkey_approval";
  const approvalHref = safeApprovalHref(
    now?.decision?.reviewUrl,
    location.origin,
  );
  return h(
    "div",
    { class: "tool-wrap" },
    card,
    h(
      "div",
      { class: "row tool-cta" },
      auth0Approval
        ? approvalHref
          ? h(
              "a",
              { class: "btn primary small", href: approvalHref },
              "Review this refund",
            )
          : h("span", { class: "dim" }, "Approval link unavailable.")
        : h(
            "button",
            {
              class: "btn primary small",
              type: "button",
              onclick: () => ctx.go("reviews", s.task!.taskId),
            },
            "Review this refund",
          ),
      h(
        "span",
        { class: "dim" },
        auth0Approval
          ? "A finance reviewer must confirm with a passkey."
          : "A permitted reviewer must decide this request.",
      ),
    ),
  );
}

export async function mountAgent(el: HTMLElement, ctx: Ctx) {
  clear(el);
  const { agent } = ctx.info;
  const model = agent.model ?? "Workers AI";

  const log = h("div", { class: "chat-log", "aria-live": "polite" });
  const input = h("textarea", {
    class: "chat-input",
    rows: "1",
    placeholder: "Message the refund agent",
    "aria-label": "Message the refund agent",
    maxlength: "2000",
  });
  const send = h(
    "button",
    { class: "btn primary", type: "submit", "aria-label": "Send" },
    "Send",
  );
  const form = h(
    "form",
    {
      class: "composer",
      onsubmit: (e: Event) => {
        e.preventDefault();
        send_(input.value);
      },
    },
    input,
    send,
  );
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send_(input.value);
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });
  const chips = h("div", { class: "suggest" });
  const side = h("div", { class: "side" });

  const reset = h(
    "button",
    {
      class: "btn small",
      type: "button",
      onclick: async () => {
        if (chat.busy) return;
        try {
          await ctx.api.clearConversation();
        } catch (e) {
          ctx.flash((e as Error).message, "bad");
          return;
        }
        chat.turns = [];
        chat.loaded = true;
        chat.version++;
        save();
        draw();
      },
    },
    "New conversation",
  );

  el.append(
    h(
      "div",
      { class: "split agent-split" },
      h(
        "section",
        { class: "panel chat", "data-ui": "" },
        h(
          "div",
          { class: "chat-head" },
          h(
            "div",
            { class: "chat-title" },
            h("h2", {}, agent.name),
            chip(model.replace(/^@cf\//, ""), "acc"),
          ),
          h(
            "p",
            { class: "dim" },
            "A real model picks the MCP tools. Task Authority decides what it may do.",
          ),
          reset,
        ),
        log,
        chips,
        form,
      ),
      side,
    ),
  );
  reset.classList.add("ghost");

  // Drawn once; disabled (not removed) while the agent works, so the composer never moves.
  for (const s of SUGGESTIONS)
    chips.append(
      h(
        "button",
        {
          class: "suggestion",
          type: "button",
          title: s.text,
          "data-guide": s.guide ?? "",
          onclick: () => send_(s.text),
        },
        s.label,
      ),
    );
  function drawChips() {
    for (const b of chips.querySelectorAll<HTMLButtonElement>("button"))
      b.disabled = chat.busy || !agent.available;
  }

  /** Messages already on screen: only newer ones play the entry animation. */
  let shown = -1;
  /** Within this distance of the end, the log follows new content; otherwise it stays put. */
  // One scroller at a time. On a wide screen the Agent view fits the window and the
  // conversation is the only thing that scrolls; on a narrow one the page scrolls and the
  // composer stays pinned to the bottom of the screen.
  const wide = () => matchMedia("(min-width: 1001px)").matches;
  const doc = document.scrollingElement ?? document.documentElement;
  const atEnd = () =>
    wide()
      ? log.scrollHeight - log.scrollTop - log.clientHeight < 48
      : doc.scrollHeight - window.scrollY - window.innerHeight < 48;
  const toEnd = () => {
    if (wide()) log.scrollTop = log.scrollHeight;
    else window.scrollTo({ top: doc.scrollHeight, behavior: "instant" });
  };
  let pinned = wide();
  log.addEventListener("scroll", () => wide() && (pinned = atEnd()), {
    passive: true,
  });
  const onPage = () => {
    if (!el.isConnected) return window.removeEventListener("scroll", onPage);
    if (!wide()) pinned = atEnd();
  };
  window.addEventListener("scroll", onPage, { passive: true });

  /** Sizes the split to the window below the header, so the page itself never scrolls. */
  const split = el.firstElementChild as HTMLElement;
  const fit = () => {
    if (!split.isConnected) return;
    if (!wide()) return void (split.style.height = "");
    const top = split.getBoundingClientRect().top + window.scrollY;
    split.style.height = `${Math.max(420, window.innerHeight - top - 20)}px`;
  };
  const onResize = () => {
    if (!el.isConnected) return window.removeEventListener("resize", onResize);
    fit();
  };
  window.addEventListener("resize", onResize);
  // The view is built before it is on screen: fit and land on the latest message once it is.
  if ("ResizeObserver" in window)
    new ResizeObserver(() => {
      fit();
      if (pinned && wide()) log.scrollTop = log.scrollHeight;
    }).observe(log);
  function drawLog() {
    const follow = (shown < 0 && wide()) || pinned;
    const keepTop = log.scrollTop;
    const opened = new Set(
      [
        ...log.querySelectorAll<HTMLDetailsElement>("details[open][data-key]"),
      ].map((d) => d.dataset.key!),
    );
    const before = shown;
    clear(log);
    if (!agent.available)
      log.append(
        h(
          "div",
          { class: "notice warn" },
          h("b", {}, "The agent is offline. "),
          "This server has no model configured, so nothing will answer. The rest of the sandbox still works.",
        ),
      );
    if (!chat.turns.length && !chat.loaded && !chat.loadFailed)
      log.append(h("p", { class: "dim" }, "Loading the conversation…"));
    else if (!chat.turns.length)
      log.append(
        empty(
          "Tell the agent what the customer needs",
          "It looks up the order, asks the refund app over MCP, and tells you what policy decided. Try a suggestion below.",
        ),
      );
    chat.turns.forEach((t, i) => {
      const fresh = before >= 0 && i >= before ? " fresh" : "";
      if (t.role === "user") {
        log.append(h("div", { class: `msg user${fresh}` }, h("p", {}, t.text)));
        return;
      }
      log.append(
        h(
          "div",
          { class: `msg agent${t.failed ? " failed" : ""}${fresh}` },
          h("span", { class: "avatar", "aria-hidden": "true" }),
          h(
            "div",
            { class: "msg-body" },
            t.steps.length
              ? h(
                  "div",
                  { class: "tools" },
                  ...t.steps.map((s) => toolCard(s, ctx)),
                )
              : null,
            h("p", {}, assistantReplyForDisplay(t.text)),
            underTheHood(t),
          ),
        ),
      );
    });
    for (const d of log.querySelectorAll<HTMLDetailsElement>(
      "details[data-key]",
    ))
      if (opened.has(d.dataset.key!)) d.open = true;
    shown = chat.turns.length;
    if (chat.busy) {
      log.append(liveMsg);
      drawLive();
    }
    if (follow) toEnd();
    else if (wide()) log.scrollTop = keepTop;
  }

  /** A finished turn's timeline, collapsed under its reply. */
  function underTheHood(t: Extract<ChatTurn, { role: "agent" }>) {
    // Turns loaded from the server carry tool steps only; this page adds model calls.
    const beats = t.beats ?? t.steps.map(toolBeat);
    if (!beats.length) return null;
    const models = beats.filter((b) => b.kind === "model").length;
    const tools = beats.filter((b) => b.kind === "tool").length;
    return h(
      "details",
      { class: "under", "data-key": `under:${chat.turns.indexOf(t)}` },
      h(
        "summary",
        {},
        [
          "Under the hood",
          models ? `${models} model calls` : "",
          `${tools} MCP calls`,
          t.ms ? secs(t.ms) : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      timeline(beats, false),
    );
  }

  // The in-progress turn is one element updated in place, so events never replay the
  // entry animation of everything above it.
  const liveBody = h("div", { class: "msg-body" });
  const liveMsg = h(
    "div",
    { class: "msg agent fresh" },
    h("span", { class: "avatar", "aria-hidden": "true" }),
    liveBody,
  );
  function drawLive() {
    clear(liveBody);
    put(
      liveBody,
      h(
        "p",
        { class: "working", role: "status" },
        h(
          "span",
          { class: "typing", "aria-hidden": "true" },
          h("i"),
          h("i"),
          h("i"),
        ),
        liveHeadline(),
        h("span", {
          class: "beat-ms mono",
          "data-since": String(liveStart),
        }),
      ),
      live.length ? timeline(live, true) : null,
    );
    if (pinned) toEnd();
  }

  /** What the agent is doing right now, in words. */
  function liveHeadline(): string {
    const cur = live[live.length - 1];
    if (!cur) return "Sending your message to the agent…";
    if (cur.ms !== undefined)
      return cur.kind === "tool"
        ? "Reading the result…"
        : "Calling the refund app…";
    return cur.kind === "model"
      ? `${model.replace(/^@cf\//, "")} is deciding what to do…`
      : `Calling ${cur.detail ?? "a tool"} over MCP…`;
  }

  function draw() {
    drawLog();
    drawChips();
    send.disabled = chat.busy || !agent.available;
    input.disabled = chat.busy || !agent.available;
  }

  function send_(raw: string) {
    if (!raw.trim() || chat.busy) return;
    // Sending is a request to see the answer: follow it.
    pinned = true;
    input.value = "";
    input.style.height = "auto";
    void ask(ctx, raw);
  }

  // ----- right column: what is real, and what the agent has registered -----
  let ops: Operation[] = [];
  let budget: Budget | undefined;
  const how = fold(
    "how",
    "How a request travels",
    "Model, MCP, policy, you",
    h(
      "ol",
      { class: "path" },
      h(
        "li",
        {},
        h("b", {}, "Model. "),
        `${model} on Workers AI reads your message and picks tools.`,
      ),
      h(
        "li",
        {},
        h("b", {}, "MCP. "),
        "Each tool call is a JSON-RPC request to ",
        h("code", {}, "/mcp"),
        " (MCP Tasks 2026-07-28) with the agent's own Auth0 machine token.",
      ),
      h(
        "li",
        {},
        h("b", {}, "Task Authority. "),
        "The refund app asks the policy engine. It allows, holds for a person, or refuses, the same as for REST or a CLI.",
      ),
      h(
        "li",
        {},
        h("b", {}, "You. "),
        "Held refunds wait in Reviews for your Auth0 sign-in with MFA. The agent picks the result up with tasks/get.",
      ),
    ),
    h(
      "p",
      { class: "dim" },
      "Nothing in this path is scripted. Only the payment is simulated.",
    ),
  );
  // The refunds panel keeps its frame while it loads, so the column never jumps.
  const recent = panel(
    h("h2", {}, "Refunds"),
    h("p", { class: "dim" }, "Loading…"),
  );
  recent.classList.add("refunds");
  side.append(recent, how, connectPanel(ctx));

  async function refresh() {
    try {
      const s = await ctx.api.state();
      ops = s.operations;
      budget = s.budget;
    } catch (e) {
      recent.replaceChildren(h("h2", {}, "Refunds"));
      const box = h("div", {});
      recent.append(box);
      mountError(box, e, ctx, () => void refresh());
      return;
    }
    const max = ctx.info.limits.maxPending;
    const pending = ops.filter((o) => o.state === "pending_approval").length;
    const kids: (Node | null)[] = [
      h(
        "div",
        { class: "row panel-title" },
        h("h2", {}, "Refunds"),
        h("span", { class: "spacer" }),
        pending
          ? h(
              "button",
              {
                class: "btn small",
                type: "button",
                onclick: () => ctx.go("reviews"),
              },
              `Review ${pending} waiting`,
            )
          : null,
      ),
    ];
    if (budget)
      kids.push(
        h(
          "div",
          { class: "meter-row" },
          h(
            "div",
            { class: "meter-label" },
            h("span", {}, "Agent budget today"),
            h(
              "span",
              { class: "num" },
              `${money(budget.usedMinor)} of ${money(budget.maxMinor)}`,
            ),
          ),
          h(
            "div",
            { class: "meter", "aria-hidden": "true" },
            h("i", {
              style: `width:${Math.min(100, (budget.usedMinor / Math.max(1, budget.maxMinor)) * 100).toFixed(1)}%`,
            }),
          ),
          max
            ? h(
                "p",
                { class: "dim" },
                `${pending} of ${max} pending refunds used`,
              )
            : null,
        ),
      );
    if (!ops.length)
      kids.push(empty("No refunds yet", "Ask the agent for one."));
    else
      kids.push(
        h(
          "ul",
          { class: "oplist" },
          ...ops.slice(0, 5).map((o) =>
            h(
              "li",
              {},
              h(
                "button",
                {
                  class: "oprow",
                  type: "button",
                  title: "Open its audit trail",
                  onclick: () => ctx.go("audit", o.id),
                },
                h("span", { class: "num" }, money(o.amountMinor, o.currency)),
                h("span", { class: "op-who" }, o.customer ?? o.resource),
                stateChip(o.state),
                h("span", { class: "dim op-age" }, ago(o.createdAt)),
              ),
            ),
          ),
        ),
        ops.length > 5
          ? h(
              "button",
              {
                class: "link",
                type: "button",
                onclick: () => ctx.go("audit"),
              },
              `View all ${ops.length} in Audit`,
            )
          : null,
      );
    recent.replaceChildren(...kids.filter((k): k is Node => k !== null));
  }

  // Live timers: one cheap text update a tenth of a second, no re-render.
  const tick = setInterval(() => {
    if (!el.isConnected) return clearInterval(tick);
    for (const t of el.querySelectorAll<HTMLElement>("[data-since]"))
      t.textContent = secs(performance.now() - Number(t.dataset.since));
  }, 100);
  const me = {
    draw,
    drawLive: () => {
      if (chat.busy && liveMsg.isConnected) drawLive();
    },
    async settled() {
      if (view !== me || !el.isConnected) return;
      await refresh();
      input.focus();
    },
  };
  view = me;
  const loading = loadConversation(ctx);
  draw();
  await refresh();
  await loading;
  if (ctx.agentPrompt) {
    const p = ctx.agentPrompt;
    ctx.agentPrompt = undefined;
    void ask(ctx, p);
  }
}
