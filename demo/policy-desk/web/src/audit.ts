import type { Ctx } from "./ctx";
import {
  ago,
  chip,
  clear,
  empty,
  h,
  fold,
  money,
  pageHead,
  panel,
  stateChip,
  when,
} from "./dom";
import { loadConversation, mcpExchanges } from "./agent";
import { errorPanel, mountError } from "./ui";
import type { Operation } from "./types";

export const VIEWED_AUDIT = "pd.viewed.audit";

export async function mountAudit(el: HTMLElement, ctx: Ctx) {
  clear(el);
  const left = h("div", {});
  const right = h("div", {});
  el.append(
    pageHead(
      "Audit",
      "Every state change, who caused it, and under which policy version and rules.",
    ),
    h("div", { class: "split review-split" }, left, right),
  );
  let ops: Operation[] = [];
  try {
    ops = (await ctx.api.state()).operations;
  } catch (e) {
    mountError(left, e, ctx, () => void mountAudit(el, ctx));
    return;
  }
  let selected =
    ctx.focusOp ??
    ops.find((o) => o.approvalId && o.state !== "pending_approval")?.id ??
    ops[0]?.id;

  function drawList() {
    clear(left);
    const p = panel(
      h(
        "h2",
        {},
        "Operations",
        h("span", { class: "count" }, String(ops.length)),
      ),
    );
    if (!ops.length)
      p.append(
        empty(
          "No operations yet",
          "Ask the agent for a refund and it will appear here with a timeline.",
        ),
        h(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: () => ctx.go("agent"),
          },
          "Open the agent",
        ),
      );
    else
      p.append(
        h(
          "ul",
          { class: "list" },
          ...ops.map((o) =>
            h(
              "li",
              {},
              h(
                "button",
                {
                  class: "pick",
                  type: "button",
                  "aria-current": String(o.id === selected),
                  onclick: () => {
                    selected = o.id;
                    drawList();
                    void show(o.id).then(() => {
                      if (window.matchMedia("(max-width: 860px)").matches)
                        right.scrollIntoView({
                          block: "start",
                          behavior: "smooth",
                        });
                    });
                  },
                },
                h(
                  "strong",
                  {},
                  `${money(o.amountMinor, o.currency)} · ${o.customer ?? o.id}`,
                ),
                h(
                  "span",
                  { class: "row" },
                  stateChip(o.state),
                  h("span", { class: "dim" }, ago(o.createdAt)),
                ),
              ),
            ),
          ),
        ),
      );
    left.append(p);
  }

  let showing = 0;
  async function show(id: string) {
    // The previous timeline stays (dimmed) until this one arrives: no collapse, no jump.
    const n = ++showing;
    right.setAttribute("aria-busy", "true");
    let ev;
    try {
      [ev] = await Promise.all([ctx.api.audit(id), loadConversation(ctx)]);
    } catch (e) {
      if (n !== showing) return;
      right.replaceChildren(panel(errorPanel(e, ctx, () => void show(id))));
      right.removeAttribute("aria-busy");
      return;
    }
    if (n !== showing) return;
    const op = ops.find((o) => o.id === id);
    const p = panel(
      h(
        "div",
        { class: "row panel-title" },
        h("h2", {}, "Timeline"),
        op ? stateChip(op.state) : null,
        h("span", { class: "spacer" }),
        h("span", { class: "mono dim" }, id),
      ),
    );
    if (!ev.length)
      p.append(
        empty(
          "No events recorded",
          "The service has recorded nothing for this operation.",
        ),
      );
    else
      p.append(
        h(
          "div",
          { class: "tablewrap" },
          h(
            "table",
            {},
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", {}, "When"),
                h("th", {}, "Event"),
                h("th", {}, "Actor chain"),
                h("th", {}, "Policy and rules"),
              ),
            ),
            h(
              "tbody",
              {},
              ...ev.map((e) =>
                h(
                  "tr",
                  {},
                  h(
                    "td",
                    { class: "dim nowrap", title: when(e.at) },
                    new Date(e.at).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                      second: "2-digit",
                    }),
                  ),
                  h(
                    "td",
                    { class: "mono" },
                    e.type,
                    e.detail ? h("div", { class: "dim" }, e.detail) : null,
                    e.reviewerReason
                      ? h(
                          "div",
                          { class: "reviewer-reason" },
                          `Reviewer's reason: “${e.reviewerReason}”`,
                        )
                      : null,
                  ),
                  h("td", {}, e.actorChain.join(" → ") || "not recorded"),
                  h(
                    "td",
                    {},
                    h(
                      "span",
                      { class: "row" },
                      e.policyVersion
                        ? chip(`policy ${e.policyVersion}`)
                        : null,
                      ...(e.ruleIds ?? []).map((r) => chip(`rule ${r}`)),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    const run = ctx.runs.get(id);
    right.replaceChildren(
      p,
      run
        ? fold(
            "audit-mcp",
            "What the agent sent over MCP",
            `${run.exchanges.length} JSON-RPC exchange${run.exchanges.length === 1 ? "" : "s"}`,
            h(
              "p",
              { class: "dim" },
              "Exactly as the refund app's MCP server received and answered them.",
            ),
            mcpExchanges(run),
          )
        : h(
            "p",
            { class: "dim aside" },
            "The MCP requests behind an operation show here once the agent has made them in this sandbox.",
          ),
    );
    right.removeAttribute("aria-busy");
    if (ev.some((e) => e.type.startsWith("approval.")))
      try {
        sessionStorage.setItem(VIEWED_AUDIT, "1");
      } catch {
        /* optional */
      }
    ctx.changed();
  }

  drawList();
  if (selected) await show(selected);
  else
    right.append(
      panel(empty("No timeline yet", "Pick an operation once you have one.")),
    );
}
