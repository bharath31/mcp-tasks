// Guided reference page. All data shown comes from the app's or the service's
// real responses; nothing here is an animation.
type Config = {
  providerMode?: string;
  demoMode?: string;
  auth0Domain?: string;
};
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const text = (el: HTMLElement, s: string) => ((el.textContent = s), el);
const h = (
  tag: string,
  props: Record<string, string> = {},
  ...kids: Array<Node | string>
) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};

// Tabs
document.querySelectorAll<HTMLButtonElement>("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("nav button")
      .forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    for (const s of ["run", "inspect", "understand"])
      $(s).hidden = s !== b.dataset.tab;
  }),
);

text($("endpoint"), `${location.origin}/mcp`);
document.querySelectorAll<HTMLElement>("pre.prompt").forEach((pre) => {
  const btn = h("button", { class: "act secondary", type: "button" }, "Copy");
  btn.addEventListener("click", () =>
    navigator.clipboard
      ?.writeText(pre.textContent ?? "")
      .then(() => text(btn, "Copied")),
  );
  pre.after(btn);
});

let config: Config = {};
fetch("/api/config")
  .then((r) => r.json())
  .then((c: Config) => {
    config = c;
    const banner = $("banner");
    banner.replaceChildren(
      h("span", {}, "Environment:"),
      pill(
        c.providerMode === "stripe-test"
          ? "Stripe test mode (real API, test money)"
          : "Payment provider: SIMULATOR (no Stripe calls)",
        c.providerMode === "stripe-test" ? "live" : "fixture",
      ),
      pill("Warehouse events: synthetic producer", "fixture"),
      pill(
        c.auth0Domain
          ? `Auth0 tenant configured: ${c.auth0Domain}`
          : "Auth0 not configured here",
        c.auth0Domain ? "live" : "off",
      ),
      pill("Permissions: FGA via Task Authority", "live"),
      pill(
        c.demoMode === "true"
          ? "Demo mode ON: scenario controls mounted"
          : "Demo mode off",
        c.demoMode === "true" ? "fixture" : "live",
      ),
    );
    text(
      $("providerLabel"),
      c.providerMode === "stripe-test"
        ? "Stripe (test mode)"
        : "Payment provider SIMULATOR",
    );
  })
  .catch(() =>
    text($("banner"), "Could not load environment (is the app running?)"),
  );

function pill(label: string, kind: "live" | "fixture" | "off") {
  return h("span", { class: `pill ${kind}` }, label);
}

// Operator-backed inspection and scenarios
const op = () => ({
  authorization: `Bearer ${$<HTMLInputElement>("opToken").value}`,
});
let current: {
  orgId: string;
  orderId: string;
  paymentId: string;
  taskId: string;
} | null = null;

async function operator(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...op(), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  text(
    $("response"),
    `${res.status} ${path}\n${JSON.stringify(data, null, 2)}`,
  );
  return { res, data };
}

async function load() {
  const taskId = $<HTMLInputElement>("taskId").value.trim();
  const { res, data } = await operator(
    `/operator/task?taskId=${encodeURIComponent(taskId)}`,
  );
  const summary = $("taskSummary");
  const table = $<HTMLTableElement>("timeline");
  if (!res.ok) {
    table.hidden = true;
    summary.replaceChildren(
      h(
        "div",
        { class: "card deny" },
        `Could not load: ${data.error ?? res.status}`,
      ),
    );
    return;
  }
  const t = data.task;
  current = {
    taskId: t.taskId,
    orgId: t.request ? "" : "",
    orderId: t.request.orderId,
    paymentId: t.request.paymentId,
  };
  summary.replaceChildren(
    h(
      "div",
      { class: "card" },
      h("strong", {}, `${t.status} / ${t.stage}`),
      ` – ${t.statusMessage ?? ""}`,
      h("br"),
      h("code", {}, `operation ${t.operationId ?? "—"}`),
    ),
  );
  const body = table.querySelector("tbody")!;
  body.replaceChildren(
    ...data.timeline.map(
      (e: {
        at: string;
        layer: string;
        actor: string;
        event: string;
        detail: string;
      }) =>
        h(
          "tr",
          {},
          h("td", {}, e.at.replace("T", " ").replace(".000Z", "")),
          h(
            "td",
            {
              class:
                e.layer === "task authority"
                  ? "layer-authority"
                  : "layer-customer",
            },
            e.layer,
          ),
          h("td", {}, e.actor),
          h("td", {}, e.event),
          h("td", {}, e.detail),
        ),
    ),
  );
  table.hidden = false;
}
$("loadTimeline").addEventListener("click", () => void load());
$("runWorker").addEventListener("click", async () => {
  await operator("/operator/worker/run", {});
  if ($<HTMLInputElement>("taskId").value) await load();
});

const scenarios: Array<{
  title: string;
  blurb: string;
  label: string;
  run?: () => Promise<unknown> | null | undefined;
  manual?: string;
}> = [
  {
    title: "Return received (fixture)",
    blurb:
      "Signs and ingests a synthetic warehouse event for the loaded task, as the warehouse would.",
    label: "Emit event",
    run: async () =>
      current &&
      operator("/operator/warehouse-event", {
        orgId: $<HTMLInputElement>("orgId").value,
        orderId: current.orderId,
        paymentId: current.paymentId,
      }),
  },
  {
    title: "Manager loses access",
    blurb:
      "Removes the manager's refund_approve relation in FGA. A later claim is refused and a fresh eligible decision is required.",
    label: "Remove permission",
    run: () =>
      operator("/operator/permission", {
        user: `user:${$<HTMLInputElement>("mgr").value}`,
        relation: "refund_approve",
        org: $<HTMLInputElement>("orgId").value,
        granted: false,
      }),
  },
  {
    title: "Restore manager access",
    blurb: "Writes the relation back.",
    label: "Restore permission",
    run: () =>
      operator("/operator/permission", {
        user: `user:${$<HTMLInputElement>("mgr").value}`,
        relation: "refund_approve",
        org: $<HTMLInputElement>("orgId").value,
        granted: true,
      }),
  },
  {
    title: "Revoke agent authority",
    blurb:
      "Revokes the task's delegation at the service. The next claim reports delegation_revoked and no refund is sent.",
    label: "Revoke delegation",
    run: () =>
      current && operator("/operator/revoke", { taskId: current.taskId }),
  },
  {
    title: "Lose the provider's response",
    blurb:
      "Simulator only: the provider refunds, then the response is lost. Watch the task reconcile to one refund.",
    label: "Arm fault",
    run: () => operator("/operator/faults", { loseResponseAfterSuccess: 1 }),
  },
  {
    title: "Provider outage",
    blurb: "Simulator only: three provider calls fail before doing anything.",
    label: "Arm fault",
    run: () => operator("/operator/faults", { unavailable: 3 }),
  },
  {
    title: "Wrong organization",
    blurb:
      "Open the review link in a profile signed in as the Southridge manager. The service refuses with not_authorized and the attempt appears in the timeline.",
    label: "Manual",
    manual: "manual",
  },
  {
    title: "Changed amount",
    blurb:
      "Ask the agent to refund a different amount for the same order. It becomes a separate exact operation that needs its own approval; the first approval cannot be reused.",
    label: "Manual",
    manual: "manual",
  },
  {
    title: "Disconnected client",
    blurb:
      "Close the MCP client after requesting the refund, approve, then reconnect and call tasks/get.",
    label: "Manual",
    manual: "manual",
  },
  {
    title: "Expired approval",
    blurb:
      "Wait past the approval window (30 minutes by default) before the worker dispatches. The old approval never authorizes; a fresh decision is requested.",
    label: "Manual",
    manual: "manual",
  },
];
const grid = $("scenarios");
grid.before(
  h(
    "div",
    { class: "row" },
    h(
      "div",
      {},
      h("label", { for: "orgId" }, "Organization id"),
      h("input", { id: "orgId", value: "org_northstar" }),
    ),
    h(
      "div",
      {},
      h("label", { for: "mgr" }, "Manager subject (Auth0 user id)"),
      h("input", { id: "mgr", placeholder: "auth0|…" }),
    ),
  ),
);
for (const s of scenarios) {
  const btn = h(
    "button",
    { class: `act ${s.manual ? "secondary" : ""}`, type: "button" },
    s.label,
  ) as HTMLButtonElement;
  if (s.manual) btn.disabled = true;
  else
    btn.addEventListener("click", async () => {
      await s.run?.();
      if (current) await load();
    });
  grid.append(
    h(
      "div",
      { class: "card" },
      h("strong", {}, s.title),
      h("p", {}, s.blurb),
      btn,
    ),
  );
}
void config;
