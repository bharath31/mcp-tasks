type Kid = Node | string | null | undefined | false;
type Props = Record<
  string,
  string | boolean | ((e: Event) => void) | undefined
>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...kids: (Kid | Kid[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid);
  }
  return el;
}

export const clear = (el: Element) => el.replaceChildren();

export function money(minor: number | undefined, currency = "USD"): string {
  if (minor === undefined) return "n/a";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    minor / 100,
  );
}

export function when(iso: string | undefined): string {
  if (!iso) return "n/a";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ago(iso: string | undefined): string {
  if (!iso) return "";
  const s = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export const chip = (
  text: string,
  kind: "" | "ok" | "warn" | "bad" | "acc" = "",
) => h("span", { class: `chip ${kind}`.trim() }, text);

/** "240 ms", "1.8 s". */
export const secs = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

export const json = (v: unknown) => JSON.stringify(v, null, 2);

export const scalar = (v: unknown): string =>
  typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);

export function kv(entries: [string, unknown][], mono = true): HTMLElement {
  const dl = h("dl", { class: "kv" });
  for (const [k, v] of entries) {
    dl.append(
      h("dt", {}, k),
      h("dd", { class: mono ? "mono" : "" }, scalar(v)),
    );
  }
  return dl;
}

export function empty(title: string, body: string): HTMLElement {
  return h("div", { class: "empty" }, h("strong", {}, title), body);
}

export function note(
  kind: "" | "bad" | "ok" | "warn",
  ...kids: Kid[]
): HTMLElement {
  return h(
    "div",
    { class: `note ${kind}`.trim(), role: kind === "bad" ? "alert" : "status" },
    ...kids,
  );
}

export function stateChip(state: string): HTMLElement {
  const kind: BadgeKind =
    state === "approved" ||
    state === "executed" ||
    state === "claimed" ||
    state === "completed"
      ? "allow"
      : state === "rejected" ||
          state === "denied" ||
          state === "expired" ||
          state === "cancelled"
        ? "deny"
        : "approve";
  return badge(kind, state.replace(/_/g, " "), state);
}

import { GLOSSARY } from "./glossary";

/** A term with a plain-language explanation on hover and keyboard focus. */
export function term(key: string, label?: string): HTMLElement {
  const g = GLOSSARY[key];
  const text = label ?? g?.term ?? key;
  if (!g) return h("span", {}, text);
  const id = `tip-${key}-${Math.random().toString(36).slice(2, 7)}`;
  return h(
    "span",
    { class: "term", tabindex: "0", "aria-describedby": id },
    text,
    h(
      "span",
      { class: "tip", role: "tooltip", id },
      h("b", {}, g.term),
      g.text,
    ),
  );
}

export type BadgeKind =
  "allow" | "approve" | "step_up" | "deny" | "info" | "plain";
export function badge(
  kind: BadgeKind,
  label: string,
  glossaryKey?: string,
): HTMLElement {
  const b = h("span", { class: `badge ${kind}` }, label);
  if (!glossaryKey) return b;
  const g = GLOSSARY[glossaryKey];
  if (!g) return b;
  const id = `tip-${glossaryKey}-${Math.random().toString(36).slice(2, 7)}`;
  b.setAttribute("tabindex", "0");
  b.setAttribute("aria-describedby", id);
  b.classList.add("term");
  b.append(
    h(
      "span",
      { class: "tip", role: "tooltip", id },
      h("b", {}, g.term),
      g.text,
    ),
  );
  return b;
}

export const panel = (...kids: (Node | string | null | false | undefined)[]) =>
  h("section", { class: "panel", "data-ui": "" }, ...kids);

/** One plain line saying what a panel shows and why it matters. */
export const purpose = (text: string) => h("p", { class: "purpose" }, text);

export function put(el: Element, ...kids: Kid[]): void {
  for (const k of kids)
    if (k !== null && k !== undefined && k !== false) el.append(k);
}

/** A tab's title row: the noun, one plain sentence, and the tab's actions on the right. */
export function pageHead(
  title: string,
  sub?: string | null,
  ...actions: Kid[]
): HTMLElement {
  return h(
    "header",
    { class: "page-head" },
    h(
      "div",
      { class: "page-head-text" },
      // The tab in the header already names the screen, so the title is for screen readers.
      h("h1", { class: "sr" }, title),
      sub ? h("p", {}, sub) : null,
    ),
    actions.some(Boolean)
      ? h("div", { class: "row page-actions" }, ...actions)
      : null,
  );
}

const FOLDS = "pd.folds";
function foldState(): Record<string, boolean> {
  try {
    return JSON.parse(sessionStorage.getItem(FOLDS) ?? "{}");
  } catch {
    return {};
  }
}

/**
 * A secondary panel folded to one line until the visitor opens it. The open state is
 * remembered for the visit, so a tab switch (which remounts the view) keeps it.
 */
export function fold(
  key: string,
  title: string,
  hint: string,
  ...kids: Kid[]
): HTMLDetailsElement {
  const d = h(
    "details",
    { class: "panel fold", "data-ui": "", "data-fold": key },
    h(
      "summary",
      {},
      h("span", { class: "fold-title" }, title),
      h("span", { class: "fold-hint" }, hint),
    ),
    h("div", { class: "fold-body" }, ...kids),
  );
  d.open = foldState()[key] === true;
  d.addEventListener("toggle", () => {
    try {
      sessionStorage.setItem(
        FOLDS,
        JSON.stringify({ ...foldState(), [key]: d.open }),
      );
    } catch {
      /* optional */
    }
  });
  return d;
}

/**
 * The demo disclosure as an info mark beside the wordmark: the full text shows on hover,
 * keyboard focus and tap, and is the button's description for screen readers.
 */
export function aboutDemo(): HTMLElement {
  const id = `about-${Math.random().toString(36).slice(2, 7)}`;
  const wrap = h("span", { class: "about" });
  const btn = h(
    "button",
    {
      class: "about-btn",
      type: "button",
      "aria-label": "About this demo",
      "aria-describedby": id,
      "aria-expanded": "false",
      onclick: () => {
        const open = !wrap.classList.contains("open");
        wrap.classList.toggle("open", open);
        btn.setAttribute("aria-expanded", String(open));
      },
    },
    "i",
  );
  const tip = h(
    "span",
    { class: "about-tip", role: "tooltip", id },
    h("b", {}, "Proposed design, reference implementation. "),
    "Not an Auth0 product. Payments are simulated. The agent is a real model; sign-in, step-up and approvals use real Auth0.",
  );
  const close = (e: Event) => {
    if (
      wrap.classList.contains("open") &&
      (e.type === "keydown"
        ? (e as KeyboardEvent).key === "Escape"
        : !e.composedPath().includes(wrap))
    ) {
      wrap.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    }
  };
  document.addEventListener("click", close);
  document.addEventListener("keydown", close);
  wrap.append(btn, tip);
  return wrap;
}
