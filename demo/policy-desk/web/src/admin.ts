// Operator page (/admin): who uses the demo and what it consumes. Data comes from
// GET /sandbox/admin/usage, which the Worker serves only to allowlisted operators.
// ?mock=1 renders fixture data with no Auth0 (for design review only).
import * as auth from "./auth";
import { h } from "./dom";

type Sandbox = {
  active: boolean;
  generation: number;
  createdAt: string;
  expiresAt: string;
  lastResetAt: string;
};
type User = {
  sandboxId: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  sandbox: Sandbox | null;
  sandboxesCreated: number;
  resets: number;
  scenarioRuns: number;
  policyPublishes: number;
  simulations: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  operations: number;
  autoAllowed: number;
  denied: number;
  approvalsRequested: number;
  approvalsApproved: number;
  approvalsRejected: number;
  refundsExecuted: number;
  policyVersions: number;
};
type Day = {
  day: string;
  newVisitors: number;
  activeSandboxes: number;
  sandboxesCreated: number;
  scenarioRuns: number;
  modelCalls: number;
  tokens: number;
};
type UsageEvent = {
  at: string;
  sandboxId: string;
  email: string | null;
  kind: string;
  detail: Record<string, unknown> | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
};
type Usage = {
  generatedAt: string;
  modelTracking: boolean;
  totals: Record<string, number>;
  daily: Day[];
  users: User[];
  recent: UsageEvent[];
};

const app = document.getElementById("app")!;
const mock = new URLSearchParams(location.search).get("mock") === "1";
const state = {
  days: 14,
  metric: "activeSandboxes" as keyof Omit<Day, "day">,
  query: "",
  data: undefined as Usage | undefined,
  who: undefined as string | undefined,
  loading: false,
};

// ---------- formatting ----------
const nf = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const num = (n: number) => (n >= 10_000 ? compact.format(n) : nf.format(n));
function rel(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const v =
    a < 45
      ? "just now"
      : a < 3600
        ? `${Math.round(a / 60)}m`
        : a < 86400
          ? `${Math.round(a / 3600)}h`
          : `${Math.round(a / 86400)}d`;
  if (v === "just now") return v;
  return future ? `in ${v}` : `${v} ago`;
}
const full = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
const shortDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

// ---------- data ----------
async function fetchUsage(): Promise<
  { ok: true; data: Usage } | { ok: false; status: number; message: string }
> {
  if (mock) return { ok: true, data: fixture(state.days) };
  let res: Response;
  try {
    const idt = await auth.idToken();
    res = await auth.authedFetch(`/sandbox/admin/usage?days=${state.days}`, {
      headers: idt ? { "x-id-token": idt } : {},
    });
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (/login_required|missing_refresh_token|invalid_grant|expired/i.test(m))
      return { ok: false, status: 401, message: "Your session has ended." };
    return {
      ok: false,
      status: 0,
      message: "The demo is unreachable. Check your connection and retry.",
    };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok)
    return {
      ok: false,
      status: res.status,
      message: String(body.message ?? `HTTP ${res.status}`),
    };
  return { ok: true, data: body as Usage };
}

// ---------- shell ----------
function nav() {
  return h(
    "header",
    { class: "a-nav" },
    h(
      "div",
      { class: "a-crumbs" },
      h("a", { class: "wordmark", href: "/" }, "Policy Desk"),
      h("span", { class: "a-slash", "aria-hidden": "true" }, "/"),
      h("span", { class: "a-crumb" }, "Usage"),
      h("span", { class: "chip" }, "Operator"),
    ),
    h(
      "div",
      { class: "a-navright" },
      state.who ? h("span", { class: "a-who" }, state.who) : null,
      h("a", { class: "btn small", href: "/" }, "Open demo"),
      !mock && state.who
        ? h(
            "button",
            {
              class: "btn small",
              type: "button",
              onclick: () => void auth.logout(),
            },
            "Sign out",
          )
        : null,
    ),
  );
}

function screen(...kids: (Node | null)[]) {
  app.replaceChildren(nav(), h("main", { class: "a-main" }, ...kids));
}

function card(title: string, body: string, ...actions: (HTMLElement | null)[]) {
  return h(
    "section",
    { class: "a-gate" },
    h("div", { class: "a-gate-icon", "aria-hidden": "true" }),
    h("h1", {}, title),
    h("p", {}, body),
    h("div", { class: "row a-gate-actions" }, ...actions),
  );
}

const signIn = () =>
  screen(
    card(
      "Operator sign-in",
      "Sign in with the operator account to see who is using the demo and what it consumes.",
      h(
        "button",
        {
          class: "btn primary lg",
          type: "button",
          onclick: () => void auth.login({ returnTo: "/admin" }),
        },
        "Sign in with Auth0",
      ),
    ),
  );

// ---------- dashboard ----------
function header(d: Usage | undefined) {
  const seg = h(
    "div",
    { class: "a-seg", role: "group", "aria-label": "Range" },
    ...[7, 14, 30].map((n) =>
      h(
        "button",
        {
          type: "button",
          class: state.days === n ? "on" : "",
          "aria-pressed": state.days === n ? "true" : "false",
          disabled: state.loading,
          onclick: () => {
            if (state.days === n) return;
            state.days = n;
            void load();
          },
        },
        `${n}d`,
      ),
    ),
  );
  return h(
    "div",
    { class: "a-head" },
    h(
      "div",
      {},
      h("h1", {}, "Usage"),
      h(
        "p",
        { class: "a-sub" },
        "Lifetime totals, including cleaned-up sandboxes. The range filters the activity chart.",
      ),
    ),
    h(
      "div",
      { class: "a-head-actions" },
      d
        ? h(
            "span",
            { class: "a-updated", title: full(d.generatedAt) },
            h("span", { class: "a-live", "aria-hidden": "true" }),
            `Updated ${rel(d.generatedAt)}`,
          )
        : null,
      seg,
      h(
        "button",
        {
          class: "btn small",
          type: "button",
          disabled: state.loading,
          onclick: () => void load(),
        },
        state.loading ? "Refreshing…" : "Refresh",
      ),
    ),
  );
}

function kpi(label: string, value: string, sub: Node | string, hint?: string) {
  return h(
    "div",
    { class: "a-kpi", title: hint },
    h("div", { class: "a-kpi-label" }, label),
    h("div", { class: "a-kpi-value" }, value),
    h("div", { class: "a-kpi-sub" }, sub),
  );
}

function kpis(d: Usage) {
  const t = d.totals as Record<string, number>;
  const g = (k: string) => t[k] ?? 0;
  const tokens = g("inputTokens") + g("outputTokens");
  return h(
    "div",
    { class: "a-kpis" },
    kpi(
      "Visitors",
      num(g("visitors")),
      `${num(g("activeLast24h"))} active in 24h`,
    ),
    kpi(
      "Active sandboxes",
      num(g("activeSandboxes")),
      `${num(g("sandboxesCreated"))} created · ${num(g("resets"))} resets`,
    ),
    kpi(
      "Scenario runs",
      num(g("scenarioRuns")),
      `${num(g("policyPublishes"))} policy edits · ${num(g("simulations"))} what-ifs`,
    ),
    kpi(
      "Approvals",
      num(g("approvalsRequested")),
      `${num(g("approvalsApproved"))} approved · ${num(g("approvalsRejected"))} rejected`,
      "Approval requests raised in all sandboxes, live and cleaned up",
    ),
    kpi(
      "Refunds executed",
      num(g("refundsExecuted")),
      `${num(g("operations"))} operations · ${num(g("denied"))} denied`,
      "Simulated payments only",
    ),
    d.modelTracking
      ? kpi(
          "Model usage",
          num(tokens),
          `${num(g("modelCalls"))} calls · ${num(g("inputTokens"))} in · ${num(g("outputTokens"))} out`,
          "Tokens across all AI agent calls",
        )
      : kpi(
          "Model usage",
          "0",
          h("span", { class: "a-pending" }, "No model calls recorded yet"),
          "The AI refund agent reports each model call and its tokens",
        ),
  );
}

const METRICS: [keyof Omit<Day, "day">, string][] = [
  ["activeSandboxes", "Active sandboxes"],
  ["scenarioRuns", "Scenario runs"],
  ["newVisitors", "New visitors"],
  ["sandboxesCreated", "Sandboxes created"],
  ["tokens", "Model tokens"],
];

const SVG = "http://www.w3.org/2000/svg";
function s(tag: string, attrs: Record<string, string | number>, text?: string) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

function chart(d: Usage) {
  const label = METRICS.find(([k]) => k === state.metric)![1];
  const vals = d.daily.map((x) => x[state.metric]);
  const total = vals.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...vals);
  const W = 960,
    H = 220,
    padL = 8,
    padR = 8,
    padT = 12,
    padB = 28;
  const n = vals.length;
  const step = (W - padL - padR) / n;
  const bw = Math.max(4, Math.min(36, step * 0.62));
  const svg = s("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "a-chart-svg",
    role: "img",
    "aria-label": `${label} per day, last ${n} days`,
    preserveAspectRatio: "none",
  });
  for (const f of [0.5, 1])
    svg.append(
      s("line", {
        x1: padL,
        x2: W - padR,
        y1: padT + (H - padT - padB) * (1 - f),
        y2: padT + (H - padT - padB) * (1 - f),
        class: "a-grid",
      }),
    );
  svg.append(
    s("line", {
      x1: padL,
      x2: W - padR,
      y1: H - padB,
      y2: H - padB,
      class: "a-axis",
    }),
  );
  const every = n > 16 ? Math.ceil(n / 8) : n > 8 ? 2 : 1;
  d.daily.forEach((x, i) => {
    const v = vals[i]!;
    const cx = padL + step * i + step / 2;
    const bh = v ? Math.max(2, ((H - padT - padB) * v) / max) : 0;
    const g = s("g", { class: "a-bar" });
    g.append(
      s(
        "title",
        {},
        `${shortDay(x.day)}: ${nf.format(v)} ${label.toLowerCase()}`,
      ),
      s("rect", {
        x: padL + step * i,
        y: padT,
        width: step,
        height: H - padT - padB,
        class: "a-hit",
      }),
      s("rect", {
        x: cx - bw / 2,
        y: H - padB - bh,
        width: bw,
        height: bh,
        rx: 3,
        class: i === n - 1 ? "a-col today" : "a-col",
      }),
    );
    svg.append(g);
    if (i % every === 0 || i === n - 1)
      svg.append(
        s(
          "text",
          { x: cx, y: H - 8, "text-anchor": "middle", class: "a-tick" },
          i === n - 1 ? "Today" : shortDay(x.day),
        ),
      );
  });
  const tabs = h(
    "div",
    { class: "a-tabs", role: "group", "aria-label": "Activity metric" },
    ...METRICS.map(([k, l]) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": state.metric === k ? "true" : "false",
          class: state.metric === k ? "on" : "",
          onclick: () => {
            state.metric = k;
            render();
          },
        },
        l,
      ),
    ),
  );
  return h(
    "section",
    { class: "panel a-chart" },
    h(
      "div",
      { class: "a-panel-head" },
      h(
        "div",
        {},
        h("h2", {}, "Activity"),
        h(
          "p",
          { class: "a-sub" },
          h("span", { class: "a-big" }, num(total)),
          ` ${label.toLowerCase()} in the last ${n} days · peak ${num(max === 1 && !total ? 0 : max)}/day`,
        ),
      ),
      tabs,
    ),
    h("div", { class: "a-chart-wrap" }, svg),
  );
}

function sandboxCell(u: User) {
  const sb = u.sandbox;
  if (!sb)
    return h(
      "span",
      { class: "a-status gone" },
      u.sandboxesCreated ? "Cleaned up" : "None",
    );
  if (!sb.active)
    return h(
      "span",
      { class: "a-status gone", title: full(sb.expiresAt) },
      "Expired",
    );
  return h(
    "span",
    { class: "a-status on", title: `Expires ${full(sb.expiresAt)}` },
    h("span", { class: "a-dot", "aria-hidden": "true" }),
    `Active · ${rel(sb.expiresAt).replace(/^in /, "")} left`,
  );
}

function userCell(u: User) {
  const primary = u.email ?? u.name ?? "Unknown visitor";
  const initial = (u.email ?? u.name ?? "?").trim()[0]?.toUpperCase() ?? "?";
  return h(
    "div",
    { class: "a-user" },
    h(
      "span",
      { class: `a-avatar${u.email ? "" : " anon"}`, "aria-hidden": "true" },
      initial,
    ),
    h(
      "div",
      { class: "a-user-text" },
      h(
        "div",
        { class: "a-user-main" },
        primary,
        u.email && !u.emailVerified
          ? h("span", { class: "badge warn a-unver" }, "unverified")
          : null,
      ),
      h(
        "div",
        { class: "a-user-sub mono" },
        u.email && u.name && u.name !== u.email ? `${u.name} · ` : "",
        u.sandboxId,
      ),
    ),
  );
}

const n0 = (n: number) =>
  h("span", { class: n ? "" : "a-zero" }, n ? num(n) : "0");

function users(d: Usage) {
  const search = h("input", {
    class: "a-search",
    type: "search",
    placeholder: "Search email or sandbox",
    "aria-label": "Search users",
    value: state.query,
    oninput: (e: Event) => {
      state.query = (e.target as HTMLInputElement).value;
      const body = document.getElementById("a-users-body");
      if (body) body.replaceWith(usersBody(d));
    },
  });
  return h(
    "section",
    { class: "panel a-users" },
    h(
      "div",
      { class: "a-panel-head" },
      h(
        "div",
        {},
        h(
          "h2",
          {},
          "Users ",
          h("span", { class: "a-count" }, num(d.users.length)),
        ),
        h(
          "p",
          { class: "a-sub" },
          "Most recently seen first. Emails come from each visitor's verified Auth0 ID token.",
        ),
      ),
      search,
    ),
    usersBody(d),
  );
}

function usersBody(d: Usage) {
  const q = state.query.trim().toLowerCase();
  const rows = d.users.filter(
    (u) =>
      !q ||
      [u.email, u.name, u.sandboxId].some((x) => x?.toLowerCase().includes(q)),
  );
  if (!rows.length)
    return h(
      "div",
      { id: "a-users-body", class: "a-empty" },
      h("b", {}, d.users.length ? "No matches" : "No visitors yet"),
      h(
        "span",
        {},
        d.users.length
          ? "Try another email or sandbox id."
          : "People appear here the first time they sign in to the demo.",
      ),
    );
  const th = (t: string, cls = "") => h("th", { class: cls }, t);
  return h(
    "div",
    { id: "a-users-body", class: "tablewrap a-table" },
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          th("User"),
          th("First seen"),
          th("Last seen"),
          th("Sandbox"),
          th("Runs", "r"),
          th("Operations", "r"),
          th("Approvals", "r"),
          th("Refunds", "r"),
          th("Model calls", "r"),
          th("Tokens", "r"),
        ),
      ),
      h(
        "tbody",
        {},
        ...rows.map((u) =>
          h(
            "tr",
            {},
            h("td", {}, userCell(u)),
            h("td", { title: full(u.firstSeenAt) }, rel(u.firstSeenAt)),
            h("td", { title: full(u.lastSeenAt) }, rel(u.lastSeenAt)),
            h("td", {}, sandboxCell(u)),
            h("td", { class: "r" }, n0(u.scenarioRuns)),
            h(
              "td",
              {
                class: "r",
                title: `${u.autoAllowed} auto-allowed · ${u.denied} denied`,
              },
              n0(u.operations),
            ),
            h(
              "td",
              {
                class: "r",
                title: `${u.approvalsApproved} approved · ${u.approvalsRejected} rejected`,
              },
              n0(u.approvalsRequested),
              u.approvalsRequested
                ? h(
                    "span",
                    { class: "a-split" },
                    h("span", { class: "ok" }, `${u.approvalsApproved}`),
                    "/",
                    h("span", { class: "bad" }, `${u.approvalsRejected}`),
                  )
                : null,
            ),
            h("td", { class: "r" }, n0(u.refundsExecuted)),
            h("td", { class: "r" }, n0(u.modelCalls)),
            h(
              "td",
              {
                class: "r",
                title: `${nf.format(u.inputTokens)} in · ${nf.format(u.outputTokens)} out`,
              },
              n0(u.inputTokens + u.outputTokens),
            ),
          ),
        ),
      ),
    ),
  );
}

const KIND: Record<string, [string, string]> = {
  sandbox_created: ["Created a sandbox", "ok"],
  sandbox_reset: ["Reset the sandbox", ""],
  scenario_run: ["Ran a scenario", "info"],
  policy_published: ["Published a policy", "warn"],
  simulation: ["Ran a what-if", ""],
  model_call: ["Model call", "violet"],
};

function eventDetail(e: UsageEvent): string {
  const d = e.detail ?? {};
  switch (e.kind) {
    case "scenario_run":
      return String(d.id ?? "").replaceAll("_", " ");
    case "policy_published":
      return String(d.version ?? "");
    case "simulation":
      return typeof d.thresholdMinor === "number"
        ? `auto-approve up to $${(d.thresholdMinor / 100).toFixed(2)}`
        : "";
    case "sandbox_created":
    case "sandbox_reset":
      return d.generation ? `generation ${d.generation}` : "";
    case "model_call":
      return `${e.model ?? "model"} · ${nf.format((e.inputTokens ?? 0) + (e.outputTokens ?? 0))} tokens`;
    default:
      return "";
  }
}

function recent(d: Usage) {
  return h(
    "section",
    { class: "panel a-recent" },
    h(
      "div",
      { class: "a-panel-head" },
      h(
        "div",
        {},
        h("h2", {}, "Recent activity"),
        h("p", { class: "a-sub" }, "The latest 60 recorded actions."),
      ),
    ),
    d.recent.length
      ? h(
          "ol",
          { class: "a-feed" },
          ...d.recent.map((e) => {
            const [label, tone] = KIND[e.kind] ?? [e.kind, ""];
            const detail = eventDetail(e);
            return h(
              "li",
              {},
              h("span", { class: `a-pip ${tone}`, "aria-hidden": "true" }),
              h(
                "div",
                { class: "a-feed-text" },
                h(
                  "div",
                  {},
                  h("b", {}, e.email ?? e.sandboxId),
                  " ",
                  label.toLowerCase(),
                ),
                detail
                  ? h("div", { class: "a-feed-detail mono" }, detail)
                  : null,
              ),
              h("time", { datetime: e.at, title: full(e.at) }, rel(e.at)),
            );
          }),
        )
      : h(
          "div",
          { class: "a-empty" },
          h("b", {}, "Nothing yet"),
          h(
            "span",
            {},
            "Sandbox resets, scenario runs and policy edits show up here.",
          ),
        ),
  );
}

function skeleton() {
  return h(
    "div",
    { class: "a-skel", "aria-busy": "true", "aria-label": "Loading usage" },
    h(
      "div",
      { class: "a-kpis" },
      ...Array.from({ length: 6 }, () => h("div", { class: "a-kpi shimmer" })),
    ),
    h("div", { class: "panel shimmer a-skel-chart" }),
    h("div", { class: "panel shimmer a-skel-table" }),
  );
}

function render(err?: { status: number; message: string }) {
  const d = state.data;
  if (err && !d) {
    if (err.status === 401) return signIn();
    if (err.status === 403)
      return screen(
        card(
          "Not an operator account",
          `${state.who ? `You are signed in as ${state.who}. ` : ""}This page is restricted to the demo's operator.`,
          h("a", { class: "btn", href: "/" }, "Open demo"),
          h(
            "button",
            {
              class: "btn primary",
              type: "button",
              onclick: () => void auth.logout(),
            },
            "Sign in as someone else",
          ),
        ),
      );
    return screen(
      card(
        "Usage is unavailable",
        err.message,
        h(
          "button",
          { class: "btn primary", type: "button", onclick: () => void load() },
          "Try again",
        ),
      ),
    );
  }
  screen(
    header(d),
    err
      ? h(
          "div",
          { class: "a-banner", role: "alert" },
          `Could not refresh: ${err.message}`,
        )
      : null,
    d ? kpis(d) : skeleton(),
    d ? chart(d) : null,
    d ? h("div", { class: "a-cols" }, users(d), recent(d)) : null,
  );
}

async function load() {
  state.loading = true;
  render();
  const r = await fetchUsage();
  state.loading = false;
  if (r.ok) {
    state.data = r.data;
    render();
  } else {
    if (r.status === 401 || r.status === 403) state.data = undefined;
    render(r);
  }
}

async function boot() {
  if (mock) {
    state.who = "operator@example.com";
    return load();
  }
  screen(skeleton());
  try {
    const cfg = await auth.loadConfig();
    const r = await auth.initAuth(cfg, { redirectPath: "/" });
    if (!r.authenticated) return signIn();
    const u = await auth.user();
    state.who = u?.email ?? u?.name;
  } catch (e) {
    return render({ status: 0, message: (e as Error).message });
  }
  await load();
  // Keep "last seen" and sandbox countdowns honest while the page stays open.
  setInterval(() => {
    if (document.visibilityState === "visible" && !state.loading) void load();
  }, 60_000);
}

// ---------- fixture (?mock=1) ----------
function fixture(days: number): Usage {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const people = [
    ["maya@northwind.dev", "Maya Chen", 4, 18, true],
    ["jordan@acme.io", "Jordan Lee", 22, 7, true],
    ["priya.r@fabrikam.com", "Priya Raman", 60, 12, false],
    ["sam@contoso.ai", "Sam Okafor", 300, 3, false],
    [null, null, 900, 1, false],
  ] as const;
  const users: User[] = people.map(([email, name, mins, runs, active], i) => ({
    sandboxId: `sbx_${(i + 1).toString(16).padStart(2, "0")}a3c9e1f04b7d2a6c58e9f1`,
    email,
    emailVerified: !!email,
    name,
    firstSeenAt: iso((i + 1) * 86400_000 * 1.7),
    lastSeenAt: iso(mins * 60_000),
    sandbox: active
      ? {
          active: true,
          generation: 2,
          createdAt: iso(mins * 60_000 + 300_000),
          expiresAt: iso(-(15 - (mins % 15)) * 60_000),
          lastResetAt: iso(mins * 60_000),
        }
      : null,
    sandboxesCreated: 1 + (i % 3),
    resets: i,
    scenarioRuns: runs,
    policyPublishes: i,
    simulations: i % 2,
    modelCalls: runs * 2,
    inputTokens: runs * 2 * 1180,
    outputTokens: runs * 2 * 240,
    operations: runs + 2,
    autoAllowed: Math.ceil(runs / 2),
    denied: i % 2,
    approvalsRequested: Math.floor(runs / 2),
    approvalsApproved: Math.floor(runs / 3),
    approvalsRejected: i % 2,
    refundsExecuted: Math.ceil(runs / 2) + Math.floor(runs / 3),
    policyVersions: 1 + i,
  }));
  const sum = (k: keyof User) =>
    users.reduce((a, u) => a + (u[k] as number), 0);
  const daily: Day[] = Array.from({ length: days }, (_, i) => {
    const t = new Date(now - (days - 1 - i) * 86400_000);
    const w = Math.round(3 + 6 * Math.abs(Math.sin(i * 1.3)) + i * 0.4);
    return {
      day: t.toISOString().slice(0, 10),
      newVisitors: Math.max(0, Math.round(w / 3) - (i % 2)),
      activeSandboxes: w,
      sandboxesCreated: Math.round(w * 0.7),
      scenarioRuns: w * 3,
      modelCalls: w * 6,
      tokens: w * 6 * 1420,
    };
  });
  const kinds = [
    ["scenario_run", { id: "routine_approval" }],
    ["model_call", {}],
    ["policy_published", { version: "refunds.edit-m1x9" }],
    ["sandbox_created", { generation: 1 }],
    ["simulation", { thresholdMinor: 7500 }],
    ["sandbox_reset", { generation: 2 }],
  ] as const;
  return {
    generatedAt: new Date(now).toISOString(),
    modelTracking: true,
    totals: {
      visitors: users.length,
      activeLast24h: 4,
      activeSandboxes: 3,
      sandboxesCreated: sum("sandboxesCreated"),
      resets: sum("resets"),
      scenarioRuns: sum("scenarioRuns"),
      policyPublishes: sum("policyPublishes"),
      simulations: sum("simulations"),
      operations: sum("operations"),
      autoAllowed: sum("autoAllowed"),
      denied: sum("denied"),
      approvalsRequested: sum("approvalsRequested"),
      approvalsApproved: sum("approvalsApproved"),
      approvalsRejected: sum("approvalsRejected"),
      refundsExecuted: sum("refundsExecuted"),
      modelCalls: sum("modelCalls"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
    },
    daily,
    users,
    recent: Array.from({ length: 14 }, (_, i) => {
      const [kind, detail] = kinds[i % kinds.length]!;
      const u = users[i % 4]!;
      return {
        at: iso(i * 7 * 60_000 + 40_000),
        sandboxId: u.sandboxId,
        email: u.email,
        kind,
        detail: { ...detail },
        model: kind === "model_call" ? "@cf/meta/llama-3.3-70b-instruct" : null,
        inputTokens: kind === "model_call" ? 1240 : null,
        outputTokens: kind === "model_call" ? 212 : null,
      };
    }),
  };
}

void boot();
