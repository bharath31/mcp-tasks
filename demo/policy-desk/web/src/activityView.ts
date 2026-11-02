// "Under the hood": a small dock that lists every request this page made and, from the
// Worker's Server-Timing, how that time split between Postgres, FGA and the model.
import { subscribe } from "./activity";
import { clear, h, secs } from "./dom";
import type { Activity } from "./types";

const LABELS: Record<string, string> = {
  "GET /sandbox/state": "Read operations and budget",
  "GET /sandbox/progress": "Read tour progress",
  "GET /sandbox/me": "Read your session",
  "GET /sandbox/info": "Read sandbox settings",
  "GET /sandbox/policy": "Read the policy",
  "GET /sandbox/audit": "Read the audit trail",
  "POST /sandbox/agent": "Agent turn",
  "POST /sandbox/reset": "Reset the sandbox",
  "PUT /sandbox/policy": "Publish a policy version",
  "POST /sandbox/restore-policy": "Restore the default policy",
  "POST /sandbox/simulate": "Simulate a threshold",
  "GET /v1/approval-requests": "Read the review queue",
};

function labelOf(a: Activity): string {
  const key = `${a.method} ${a.path}`;
  if (LABELS[key]) return LABELS[key]!;
  if (/\/lease$/.test(a.path)) return "Claim the refund";
  if (/\/decisions$/.test(a.path)) return "Record your decision";
  if (/\/challenge$/.test(a.path)) return "Create the approval challenge";
  if (a.path.startsWith("/v1/policies")) return "Read the policy document";
  return key;
}

function split(a: Activity): string {
  const s = a.server;
  if (!s) return "";
  return [
    s.db ? `${s.db.desc ?? "Postgres"} ${secs(s.db.ms)}` : "",
    s.fga ? `${s.fga.desc} ${secs(s.fga.ms)}` : "",
    s.model ? `${s.model.desc} ${secs(s.model.ms)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function mountActivity(): HTMLElement {
  let open = false;
  const list = h("ol", { class: "act-list" });
  const count = h("span", { class: "act-count mono" });
  const toggle = h(
    "button",
    {
      class: "act-toggle",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": "act-panel",
    },
    h("span", { class: "act-pulse", "aria-hidden": "true" }),
    "Requests",
    count,
  );
  const panel = h(
    "div",
    { class: "act-panel", id: "act-panel", hidden: true },
    h(
      "div",
      { class: "act-head" },
      h("b", {}, "Requests from this page"),
      h(
        "span",
        { class: "dim" },
        "Round trip in your browser; the split comes from the Worker's Server-Timing.",
      ),
    ),
    list,
  );
  toggle.addEventListener("click", () => {
    open = !open;
    toggle.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
  });
  const dock = h("div", { class: "act" }, toggle, panel);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) toggle.click();
  });

  subscribe((items) => {
    const running = items.filter((a) => a.ms === undefined).length;
    dock.classList.toggle("busy", running > 0);
    count.textContent = running ? `${running} running` : "";
    clear(list);
    if (!items.length)
      list.append(h("li", { class: "dim act-empty" }, "No requests yet."));
    for (const a of items.slice(0, 20))
      list.append(
        h(
          "li",
          {
            class: `act-row${a.ms === undefined ? " running" : ""}${a.failed ? " bad" : ""}`,
          },
          h(
            "div",
            { class: "act-main" },
            h("span", { class: "act-label" }, labelOf(a)),
            h("span", { class: "spacer" }),
            h(
              "span",
              {
                class: "act-ms mono",
                ...(a.ms === undefined
                  ? { "data-since": String(a.startedAt) }
                  : {}),
              },
              a.ms === undefined ? "" : secs(a.ms),
            ),
          ),
          h(
            "div",
            { class: "act-sub mono" },
            `${a.method} ${a.path}${a.status ? ` · ${a.status}` : ""}`,
            split(a) ? h("span", {}, ` · ${split(a)}`) : null,
          ),
        ),
      );
  });
  setInterval(() => {
    if (!dock.isConnected) return;
    for (const t of dock.querySelectorAll<HTMLElement>("[data-since]"))
      t.textContent = secs(performance.now() - Number(t.dataset.since));
  }, 100);
  return dock;
}
