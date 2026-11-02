import { h } from "./dom";
import { reduced, spring } from "./motion";

/** A modal sheet for the few actions that are hard to undo. It grows from its trigger and returns to it. */
export function confirmDialog(opts: {
  trigger: HTMLElement;
  title: string;
  body: string | Node;
  confirm: string;
  cancel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}): void {
  const prev = document.activeElement as HTMLElement | null;
  const r = opts.trigger.getBoundingClientRect();
  const scrim = h("div", { class: "scrim" });
  const ok = h(
    "button",
    {
      class: `btn primary${opts.danger ? " danger-fill" : ""}`,
      type: "button",
    },
    opts.confirm,
  );
  const no = h("button", { class: "btn", type: "button" }, opts.cancel);
  const sheet = h(
    "div",
    {
      class: "sheet",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "sheet-title",
    },
    h("h2", { id: "sheet-title" }, opts.title),
    h("div", { class: "sheet-body" }, opts.body),
    h("div", { class: "row" }, ok, no),
  );
  const wrap = h("div", { class: "sheet-wrap" }, scrim, sheet);
  document.body.append(wrap);
  // Origin anchored to the trigger so the sheet reads as coming from it.
  const sr = sheet.getBoundingClientRect();
  const ox = r.left + r.width / 2 - sr.left;
  const oy = r.top + r.height / 2 - sr.top;
  sheet.style.transformOrigin = `${ox}px ${oy}px`;
  const paint = (p: number) => {
    const q = Math.min(1, Math.max(0, p));
    scrim.style.opacity = String(q);
    sheet.style.opacity = String(q);
    sheet.style.transform = `scale(${0.94 + 0.06 * p})`;
    sheet.style.setProperty("--blur", `${(1 - q) * 10}px`);
  };
  let closing = false;
  const close = (restore = true) => {
    if (closing) return;
    closing = true;
    document.removeEventListener("keydown", onKey);
    void spring(sheet, "dlg", 1, 0, paint, { response: 0.3 }).then(() => {
      wrap.remove();
      if (restore) prev?.focus();
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      const f = [ok, no];
      const i = f.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]!.focus();
    }
  };
  document.addEventListener("keydown", onKey);
  scrim.addEventListener("pointerdown", () => close());
  no.addEventListener("click", () => close());
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    close(false);
    // The dialog is gone; show the work on the button that opened it.
    const t = opts.trigger as HTMLButtonElement | undefined;
    t?.setAttribute("aria-busy", "true");
    if (t) t.disabled = true;
    try {
      await opts.onConfirm();
    } finally {
      t?.removeAttribute("aria-busy");
      if (t) t.disabled = false;
    }
  });
  paint(0);
  if (reduced()) paint(1);
  else void spring(sheet, "dlg", 0, 1, paint, { response: 0.35 });
  no.focus();
}
