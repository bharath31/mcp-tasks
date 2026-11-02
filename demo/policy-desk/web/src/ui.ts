import type { Ctx } from "./ctx";
import { clear, h } from "./dom";
import { explain } from "./errors";

/** Show a real error: what happened in plain words, one recovery action, and the server codes behind a disclosure. */
export function errorPanel(
  err: unknown,
  ctx: Ctx,
  retry?: () => void,
): HTMLElement {
  const e = explain(err);
  const actions = h("div", { class: "row" });
  if (e.recovery === "signin")
    actions.append(
      h(
        "button",
        { class: "btn primary", type: "button", onclick: () => ctx.relogin() },
        "Sign in again",
      ),
    );
  if (e.recovery === "reset")
    actions.append(
      h(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: async () => {
            await ctx.api.reset();
            ctx.changed();
            location.reload();
          },
        },
        "Reset sandbox",
      ),
    );
  if ((e.recovery === "retry" || e.recovery === "reset") && retry)
    actions.append(
      h(
        "button",
        { class: "btn", type: "button", onclick: retry },
        "Try again",
      ),
    );
  const detail = e.detail
    ? e.showDetail
      ? h("p", { class: "alert-code mono" }, e.detail)
      : h(
          "details",
          { class: "alert-detail" },
          h("summary", {}, "Technical details"),
          h("pre", { class: "mono" }, e.detail),
        )
    : null;
  return h(
    "div",
    { class: "alert", role: "alert" },
    h("span", { class: "ico ico-alert alert-ico", "aria-hidden": "true" }),
    h(
      "div",
      { class: "alert-main" },
      h("b", { class: "alert-title" }, e.title),
      h("p", {}, e.body),
      actions.childNodes.length ? actions : null,
      detail,
    ),
  );
}

export function mountError(
  el: HTMLElement,
  err: unknown,
  ctx: Ctx,
  retry?: () => void,
) {
  clear(el);
  el.append(errorPanel(err, ctx, retry));
}

/** Full-page loading state: the mark and a thin indeterminate bar. Mirrors the static one in index.html. */
export function loader(
  label = "Loading Policy Desk",
  visible = false,
): HTMLElement {
  return h(
    "div",
    { class: "boot", role: "status" },
    h("span", { class: "boot-mark", "aria-hidden": "true" }),
    h("span", { class: "boot-bar", "aria-hidden": "true" }),
    h("span", { class: visible ? "boot-caption" : "sr" }, label),
  );
}

const skLine = (w: string) =>
  h("span", { class: "sk-line", style: `width:${w}` });

/** Placeholder panels shaped like the content that is about to load. */
export function skeleton(): HTMLElement {
  const block = (lines: string[]) =>
    h("div", { class: "sk-panel" }, ...lines.map(skLine));
  return h(
    "div",
    { class: "sk", role: "status", "aria-label": "Loading" },
    block(["38%", "72%", "64%"]),
    h(
      "div",
      { class: "sk-split" },
      block(["44%", "90%", "82%", "86%"]),
      block(["30%", "76%", "58%"]),
    ),
  );
}

/** "15 minutes", "1 hour", "24 hours". */
export function duration(minutes: number): string {
  if (minutes < 60) {
    const m = Math.max(1, Math.round(minutes));
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const hrs = Math.round(minutes / 6) / 10;
  return `${hrs} hour${hrs === 1 ? "" : "s"}`;
}

/** Time left on the sandbox, refreshed on its own. Warns in the last 3 minutes. */
export function countdown(expiresAt: string): HTMLElement {
  const el = h("span", { class: "ttl", role: "timer" });
  const end = new Date(expiresAt).getTime();
  const tick = () => {
    if (!el.isConnected && el.dataset.started) return clearInterval(id);
    el.dataset.started = "1";
    const left = end - Date.now();
    const min = Math.ceil(left / 60e3);
    el.className = `ttl${left <= 0 ? " bad" : min <= 3 ? " warn" : ""}`;
    el.textContent =
      left <= 0
        ? "Sandbox expired"
        : min <= 1
          ? "Under a minute left"
          : `${min} min left`;
    el.title = `Your sandbox is deleted at ${new Date(end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Reset it to start a fresh one.`;
  };
  const id = setInterval(tick, 15e3);
  tick();
  return el;
}
