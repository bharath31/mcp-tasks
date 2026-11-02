import type { Ctx, Section } from "./ctx";
import { h } from "./dom";
import { VIEWED_AUDIT } from "./audit";
import { VIEWED_POLICY } from "./policy";
import type { Budget, Operation, Progress } from "./types";

export { STEPS, nextStep, type Step, type StepId } from "./tour";
import { STEPS, nextStep, type StepId } from "./tour";

const SKIP = "pd.skipped";
const readSkips = (): StepId[] => {
  try {
    return JSON.parse(sessionStorage.getItem(SKIP) ?? "[]") as StepId[];
  } catch {
    return [];
  }
};
const writeSkips = (s: StepId[]) => {
  try {
    sessionStorage.setItem(SKIP, JSON.stringify(s));
  } catch {
    /* optional */
  }
};
const flag = (k: string) => {
  try {
    return sessionStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
export function clearProgressFlags() {
  try {
    [VIEWED_AUDIT, VIEWED_POLICY, SKIP].forEach((k) =>
      sessionStorage.removeItem(k),
    );
  } catch {
    /* optional */
  }
}

/** Completion comes from the service's own progress, derived from real state. Reading steps use a viewed flag. */
export function completion(p: Progress): Record<StepId, boolean> {
  return {
    signin: p.signedIn,
    policy: flag(VIEWED_POLICY),
    small: p.autoAllowedRefund,
    large: p.approvalRequestedRefund,
    review: p.approvedWithStepUp,
    audit: flag(VIEWED_AUDIT) && p.eventsPresent,
    change: p.policyEdited,
  };
}

const CLOSED = "pd.tour.closed";
/** Closing the tour is remembered on this device until the visitor opens it again. */
export function tourClosed(): boolean {
  try {
    return localStorage.getItem(CLOSED) === "1";
  } catch {
    return false;
  }
}
export function setTourClosed(closed: boolean) {
  try {
    if (closed) localStorage.setItem(CLOSED, "1");
    else localStorage.removeItem(CLOSED);
  } catch {
    /* optional */
  }
}

export const readSkipped = () => readSkips();

export type RailState = {
  ops: Operation[];
  budget?: Budget;
  progress: Progress;
};

/**
 * The guided tour as one slim strip above the tabs: where you are, the one thing to do next,
 * and the full list of steps behind "All steps". The collapsed strip keeps one height
 * whatever the step, so refreshing it never moves the page under the visitor.
 */
export function renderRail(
  el: HTMLElement,
  _ctx: Ctx,
  st: RailState,
  open: { value: StepId | undefined },
  onNavigate: (s: Section) => void,
  rerender: () => void,
  onClose: () => void,
  expanded: { value: boolean } = { value: false },
) {
  const done = completion(st.progress);
  const skips = readSkips();
  const current = nextStep(done, skips);
  const completed = STEPS.filter((s) => done[s.id]).length;

  const meter = h(
    "span",
    {
      class: "tour-meter",
      role: "img",
      "aria-label": `${completed} of ${STEPS.length} steps done`,
    },
    ...STEPS.map((s) =>
      h("i", {
        class: done[s.id] ? "done" : s.id === current?.id ? "cur" : "",
      }),
    ),
  );
  const toggle = h(
    "button",
    {
      class: "btn small ghost tour-all",
      type: "button",
      "aria-expanded": String(expanded.value),
      "aria-controls": "tour-steps",
      "aria-label": "All steps",
      "data-k": "all",
      onclick: () => {
        expanded.value = !expanded.value;
        rerender();
      },
    },
    "All steps",
  );
  const close = h(
    "button",
    {
      class: "btn small ghost tour-close",
      type: "button",
      "aria-label": "Close the guided tour",
      onclick: onClose,
    },
    "Close",
  );
  const line = h(
    "div",
    { class: "tour-line" },
    meter,
    h(
      "p",
      { class: "tour-text" },
      current
        ? [
            h(
              "span",
              { class: "tour-count" },
              `Step ${STEPS.indexOf(current) + 1} of ${STEPS.length}`,
            ),
            h("b", {}, current.title),
            h("span", { class: "tour-do" }, current.doThis),
          ]
        : [
            h("span", { class: "tour-count" }, "Tour finished"),
            h(
              "span",
              { class: "tour-do" },
              completed === STEPS.length
                ? "You have seen the whole story. Explore freely."
                : "Skipped steps are still under All steps.",
            ),
          ],
    ),
    current
      ? h(
          "button",
          {
            class: "btn primary small",
            type: "button",
            onclick: () => {
              open.value = current.id;
              onNavigate(current.go);
            },
          },
          current.cta,
        )
      : null,
    toggle,
    close,
  );

  const list = h("ol", { class: "steps", id: "tour-steps" });
  const shown = open.value ?? current?.id;
  for (const s of STEPS) {
    const isDone = done[s.id];
    const isSkipped = skips.includes(s.id) && !isDone;
    const isCur = s.id === current?.id;
    const isOpen = s.id === shown;
    list.append(
      h(
        "li",
        {
          class: `step ${isDone ? "done" : ""} ${isCur ? "cur" : ""}`,
          "data-step": s.id,
        },
        h(
          "button",
          {
            type: "button",
            class: "step-head",
            "data-k": `step-${s.id}`,
            "aria-expanded": String(isOpen),
            onclick: () => {
              open.value = isOpen ? undefined : s.id;
              rerender();
            },
          },
          h(
            "span",
            { class: "step-state" },
            isDone ? "Done" : isSkipped ? "Skipped" : isCur ? "Next" : "Later",
          ),
          h("span", { class: "step-title" }, s.title),
        ),
        isOpen
          ? h(
              "div",
              { class: "step-body" },
              h("p", {}, s.what),
              h(
                "div",
                { class: "row" },
                h(
                  "button",
                  {
                    class: "btn small",
                    type: "button",
                    onclick: () => onNavigate(s.go),
                  },
                  s.cta,
                ),
                !isDone && !isSkipped && s.id !== "signin"
                  ? h(
                      "button",
                      {
                        class: "btn small ghost",
                        type: "button",
                        onclick: () => {
                          writeSkips([...skips, s.id]);
                          open.value = undefined;
                          rerender();
                        },
                      },
                      "Skip this step",
                    )
                  : null,
                isSkipped
                  ? h(
                      "button",
                      {
                        class: "btn small ghost",
                        type: "button",
                        onclick: () => {
                          writeSkips(skips.filter((x) => x !== s.id));
                          rerender();
                        },
                      },
                      "Un-skip",
                    )
                  : null,
              ),
            )
          : null,
      ),
    );
  }
  list.hidden = !expanded.value;
  // A redraw replaces the buttons, so keyboard focus returns to the one that was pressed.
  const had = el.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset.k
    : undefined;
  el.replaceChildren(line, list);
  if (had) el.querySelector<HTMLElement>(`[data-k="${had}"]`)?.focus();
  // highlight the control the guide wants used
  document
    .querySelectorAll(".guide-hl")
    .forEach((n) => n.classList.remove("guide-hl"));
  if (current)
    document
      .querySelectorAll(`[data-guide="${current.id}"]`)
      .forEach((n) => n.classList.add("guide-hl"));
}
