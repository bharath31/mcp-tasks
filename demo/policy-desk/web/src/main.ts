import { getApi, PENDING_KEY } from "./api";
import { mountActivity } from "./activityView";
import * as auth from "./auth";
import { forgetConversation, mountAgent } from "./agent";
import { mountAudit } from "./audit";
import type { Ctx, Section } from "./ctx";
import { aboutDemo, clear, h } from "./dom";
import { confirmDialog } from "./dialog";
import { slideTo } from "./motion";
import { mountGlossary } from "./glossaryView";
import { landing } from "./landing";
import { mountPolicy } from "./policy";
import {
  clearProgressFlags,
  completion,
  nextStep,
  readSkipped,
  renderRail,
  STEPS,
  setTourClosed,
  tourClosed,
  type RailState,
  type StepId,
} from "./rail";
import { handBack, mountReviewer } from "./reviewer";
import { countdown, duration, errorPanel, loader, skeleton } from "./ui";
import type { AgentToolStep, Api, Info, Me } from "./types";

const TABS: [Section, string][] = [
  ["agent", "Agent"],
  ["reviews", "Reviews"],
  ["policy", "Policy"],
  ["audit", "Audit"],
  ["glossary", "Glossary"],
];

const app = document.getElementById("app")!;
/** A /review?approval=… link (from the agent or MCP) opens that review, signed in or not. */
function deepLink(): auth.AppState | undefined {
  if (location.pathname !== "/review") return undefined;
  const approval = new URLSearchParams(location.search).get("approval");
  return { section: "reviews", ...(approval ? { focusOp: approval } : {}) };
}

async function boot() {
  const api: Api = await getApi();
  const link = deepLink();
  let appState: auth.AppState | undefined;
  let authed = false;
  let initError: string | undefined;
  let stepUpError: string | undefined;

  try {
    const cfg = await auth.loadConfig();
    // Auth0 allows only the site root as a callback; a deep link travels in appState.
    const r = await auth.initAuth(cfg, { redirectPath: "/" });
    authed = r.authenticated;
    appState = r.appState ?? link;
    if (link && location.pathname !== "/") history.replaceState({}, "", "/");
    stepUpError = r.error;
    // Operator sign-in uses the site's only registered callback, then returns here.
    if (authed && appState?.returnTo === "/admin")
      return location.replace("/admin");
  } catch (e) {
    initError = (e as Error).message;
  }

  if (!authed) {
    app.replaceChildren(
      landing({
        error: initError,
        onSignIn: () => {
          void auth.login(link ?? { section: "agent" });
        },
      }),
    );
    reveal();
    return;
  }
  await console_(api, appState, stepUpError);
}

function reveal() {
  const els = document.querySelectorAll<HTMLElement>(
    ".l-how li, .l-real .cols > div, .l-real h2, .l-cta > *",
  );
  if (!("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
    },
    { threshold: 0.15 },
  );
  els.forEach((el, i) => {
    el.classList.add("reveal");
    el.style.transitionDelay = `${(i % 4) * 70}ms`;
    io.observe(el);
  });
}

async function console_(
  api: Api,
  appState?: auth.AppState,
  stepUpError?: string,
) {
  let me: Me;
  let info: Info;
  let resuming = false;
  try {
    // Auth0 did not finish the check, so replaying the decision can only be refused.
    if (stepUpError) sessionStorage.removeItem(PENDING_KEY);
    resuming = !!sessionStorage.getItem(PENDING_KEY);
  } catch {
    /* no storage, nothing to resume */
  }
  const shell = h(
    "div",
    { class: "console" },
    resuming
      ? loader("Back from Auth0. Recording your decision…", true)
      : loader(),
  );
  app.replaceChildren(shell);
  // Before the console exists: errors and the create step get a minimal header and one centered card.
  const bare = {
    relogin: () => void auth.login(),
    api,
    changed() {},
    flash() {},
    go() {},
    runs: new Map(),
    me: undefined,
    info: undefined,
  } as unknown as Ctx;
  const bareHead = () =>
    h(
      "header",
      { class: "c-head" },
      h("span", { class: "wordmark" }, "Policy Desk"),
      aboutDemo(),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn small",
          type: "button",
          onclick: () => void api.signOut(),
        },
        "Sign out",
      ),
    );
  try {
    [me, info] = await Promise.all([api.me(), api.info()]);
  } catch (e) {
    clear(shell);
    shell.append(
      bareHead(),
      h(
        "div",
        { class: "onboard" },
        errorPanel(e, bare, () => location.reload()),
      ),
    );
    return;
  }

  clear(shell);
  if (!me.initialized) {
    const ttl = info.limits.sandboxTtlMinutes ?? 15;
    const slot = h("div", { class: "onboard-err" });
    const label = h("span", {}, "Create my sandbox");
    const go = h(
      "button",
      { class: "btn primary lg block", type: "button" },
      label,
    );
    const noPasskey = h("input", {
      type: "checkbox",
      id: "no-passkey",
    }) as HTMLInputElement;
    const create = async () => {
      go.disabled = true;
      go.setAttribute("aria-busy", "true");
      label.textContent = "Creating your sandbox…";
      clear(slot);
      try {
        await api.reset({ allowAuthenticatorApp: noPasskey.checked });
        await console_(api, appState);
      } catch (e) {
        go.disabled = false;
        go.removeAttribute("aria-busy");
        label.textContent = "Create my sandbox";
        // The create button below is the retry, so the panel carries no second one.
        slot.replaceChildren(errorPanel(e, bare));
      }
    };
    go.addEventListener("click", () => void create());
    const fact = (icon: string, title: string, text: string) =>
      h(
        "li",
        {},
        h("span", { class: `ico ${icon}`, "aria-hidden": "true" }),
        h("span", {}, h("b", {}, title), text),
      );
    shell.append(
      bareHead(),
      h(
        "div",
        { class: "onboard" },
        h(
          "section",
          { class: "onboard-card", "data-ui": "" },
          h("span", { class: "onboard-mark", "aria-hidden": "true" }),
          h("h1", {}, "Create your sandbox"),
          h(
            "p",
            { class: "onboard-lead" },
            "A private copy of the policy service with its own policy, orders and a server-side refund agent.",
          ),
          h(
            "ul",
            { class: "onboard-facts" },
            fact(
              "ico-lock",
              "Private to you",
              "Only your account can see it or act in it.",
            ),
            fact(
              "ico-bolt",
              "Ready in seconds",
              "Starts with the default policy and sample orders.",
            ),
            fact(
              "ico-clock",
              `Deleted after ${duration(ttl)}`,
              "Reset it from the header for a fresh one.",
            ),
          ),
          h(
            "div",
            { class: "onboard-option" },
            h(
              "label",
              { for: "no-passkey" },
              noPasskey,
              h(
                "span",
                {},
                h("b", {}, "This device can't use a passkey. "),
                "Let routine approvals accept a code from an authenticator app (such as Google Authenticator) instead. A demo setting you can change in Policy; high-value refunds still need a passkey.",
              ),
            ),
          ),
          slot,
          go,
        ),
        h(
          "p",
          { class: "onboard-foot" },
          "Signed in as ",
          h("b", {}, me.email ?? me.name),
          ". Not you? ",
          h(
            "button",
            {
              class: "textlink",
              type: "button",
              onclick: () => void api.signOut(),
            },
            "Sign out",
          ),
        ),
      ),
    );
    return;
  }

  let section: Section = (appState?.section as Section) ?? "agent";
  let focusOp: string | undefined = appState?.focusOp;
  const runs = new Map<string, AgentToolStep>();
  const open: { value: StepId | undefined } = { value: undefined };
  const toastBox = h("div", { class: "toast", "aria-live": "polite" });
  // The guided tour lives in the header: a pill naming the next step, and a popover with
  // what to do and every step. Nothing about it takes height from the content.
  const railBox = h("section", {
    class: "tour",
    id: "tour-pop",
    "aria-label": "Guided tour",
    hidden: true,
  });
  const tourExpanded = { value: true };
  const pill = h(
    "button",
    {
      class: "tour-pill",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": "tour-pop",
    },
    "Guided tour",
  );
  const tourWrap = h("div", { class: "tour-wrap" }, pill, railBox);
  const showPop = (show: boolean) => {
    railBox.hidden = !show;
    pill.setAttribute("aria-expanded", String(show));
  };
  pill.addEventListener("click", () => showPop(railBox.hidden === true));
  document.addEventListener("click", (e) => {
    if (!railBox.hidden && !e.composedPath().includes(tourWrap)) showPop(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !railBox.hidden) {
      showPop(false);
      pill.focus();
    }
  });
  const view = h("div", { class: "view" });
  const nav = h("nav", {
    class: "tabs",
    role: "tablist",
    "aria-label": "Sections",
  });

  const ctx: Ctx = {
    api,
    me,
    info,
    runs,
    get focusOp() {
      return focusOp;
    },
    agentPrompt: undefined,
    go(s, op) {
      section = s;
      focusOp = op;
      void render();
    },
    flash(message, kind = "") {
      clear(toastBox);
      toastBox.append(
        h(
          "div",
          {
            class: `notice ${kind}`,
            role: kind === "bad" ? "alert" : "status",
          },
          message,
        ),
      );
      setTimeout(() => clear(toastBox), 6000);
    },
    changed() {
      void refreshRail();
    },
    relogin() {
      void auth.login({ section });
    },
  } as Ctx;

  // The tour's last known state. Opening "All steps", a step or a skip only redraws from
  // it, synchronously; the network is read only when real state may have changed.
  let railState: RailState | undefined;
  function drawRail() {
    if (!railState) return;
    renderRail(
      railBox,
      ctx,
      railState,
      open,
      (to) => {
        showPop(false);
        section = to;
        focusOp = undefined;
        void render();
      },
      drawRail,
      () => setTour(false),
      tourExpanded,
    );
    const state = completion(railState.progress);
    const done = STEPS.filter((x) => state[x.id]).length;
    const cur = nextStep(state, readSkipped());
    pill.replaceChildren(
      h(
        "span",
        { class: "pill-meter", "aria-hidden": "true" },
        h("i", { style: `width:${(done / STEPS.length) * 100}%` }),
      ),
      h(
        "span",
        { class: "pill-text" },
        cur
          ? `${STEPS.indexOf(cur) + 1}/${STEPS.length} · ${cur.title}`
          : "Tour finished",
      ),
      h(
        "span",
        { class: "pill-short", "aria-hidden": "true" },
        cur ? `Tour ${STEPS.indexOf(cur) + 1}/${STEPS.length}` : "Tour done",
      ),
    );
    pill.setAttribute(
      "aria-label",
      cur
        ? `Guided tour, step ${STEPS.indexOf(cur) + 1} of ${STEPS.length}: ${cur.title}`
        : "Guided tour, finished",
    );
  }
  async function refreshRail() {
    try {
      const [s, p] = await Promise.all([api.state(), api.progress()]);
      railState = { ops: s.operations, budget: s.budget, progress: p };
      drawRail();
    } catch (e) {
      clear(railBox);
      railBox.append(errorPanel(e, ctx, () => void refreshRail()));
    }
  }

  const ind = h("span", { class: "ind", "aria-hidden": "true" });
  function drawChrome() {
    clear(nav);
    for (const [id, label] of TABS)
      nav.append(
        h(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": String(id === section),
            "data-section": id,
            onclick: () => ctx.go(id),
          },
          label,
        ),
      );
    nav.append(ind);
    requestAnimationFrame(() => {
      const sel = nav.querySelector<HTMLElement>('[aria-selected="true"]');
      if (sel) slideTo(ind, sel.offsetLeft, sel.offsetWidth);
    });
  }

  let rendering = 0;
  async function render() {
    const n = ++rendering;
    drawChrome();
    // Keep the old view on screen (dimmed) while the next one loads, and hold its height,
    // so the page never collapses to a skeleton and springs back. A skeleton only appears
    // on the first load or when loading is slow.
    view.style.minHeight = `${view.offsetHeight}px`;
    view.setAttribute("aria-busy", "true");
    const slow = setTimeout(
      () => {
        if (
          n === rendering &&
          !view.firstElementChild?.classList.contains("sk")
        )
          view.replaceChildren(skeleton());
      },
      view.childElementCount ? 400 : 0,
    );
    const body = h("div", { class: "stack-lg" });
    try {
      if (section === "agent") await mountAgent(body, ctx);
      else if (section === "reviews") await mountReviewer(body, ctx);
      else if (section === "policy") await mountPolicy(body, ctx);
      else if (section === "audit") await mountAudit(body, ctx);
      else mountGlossary(body);
    } catch (e) {
      clear(body);
      body.append(errorPanel(e, ctx, () => void render()));
    }
    clearTimeout(slow);
    if (n !== rendering) return;
    view.replaceChildren(body);
    view.removeAttribute("aria-busy");
    // A new tab starts at its top, without an animated trip (the tabs stay in the header).
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "instant" });
    requestAnimationFrame(() => (view.style.minHeight = ""));
    void refreshRail();
  }

  const body = h(
    "div",
    { class: "c-body" },
    h("main", { class: "c-main" }, view),
  );
  const reopen = h(
    "button",
    {
      class: "btn small",
      type: "button",
      onclick: () => setTour(true),
    },
    "Guided tour",
  );
  function setTour(show: boolean) {
    setTourClosed(!show);
    tourWrap.hidden = !show;
    showPop(show);
    reopen.hidden = show;
    if (show) {
      drawRail();
      void refreshRail();
    }
  }
  tourWrap.hidden = tourClosed();
  reopen.hidden = !tourClosed();

  const ttlSlot = h("span", { class: "ttl-slot" });
  const drawTtl = () => {
    const at = ctx.info.limits.sandboxExpiresAt;
    ttlSlot.replaceChildren(at ? countdown(at) : "");
  };
  drawTtl();
  const header = h(
    "header",
    { class: "c-head" },
    h("span", { class: "wordmark" }, "Policy Desk"),
    aboutDemo(),
    nav,
    h("span", { class: "spacer" }),
    tourWrap,
    reopen,
    mountActivity(),
    ttlSlot,
    h("span", { class: "who" }, me.email ?? me.name),
    h(
      "button",
      {
        class: "btn small",
        type: "button",
        onclick: (e: Event) => confirmReset(e.currentTarget as HTMLElement),
      },
      h("span", { class: "wide-only" }, "Reset sandbox"),
      h("span", { class: "narrow-only" }, "Reset"),
    ),
    h(
      "button",
      { class: "btn small", type: "button", onclick: () => void api.signOut() },
      "Sign out",
    ),
  );

  function confirmReset(trigger: HTMLElement) {
    confirmDialog({
      trigger,
      title: "Reset your sandbox?",
      body: "This deletes your operations, approvals and policy versions, then restores the default policy and orders, keeping how you approve (passkey or authenticator app). Your Auth0 account is untouched. It cannot be undone.",
      confirm: "Reset sandbox",
      cancel: "Keep my data",
      onConfirm: async () => {
        try {
          await api.reset();
          ctx.info = await api.info();
          drawTtl();
          clearProgressFlags();
          forgetConversation();
          runs.clear();
          ctx.flash("Sandbox reset to the default policy.", "ok");
          section = "agent";
          await render();
        } catch (e) {
          clear(view);
          view.append(errorPanel(e, ctx));
        }
      },
    });
  }

  shell.append(header, body, toastBox);

  if (stepUpError) {
    section = "reviews";
    ctx.flash(
      `Auth0 did not finish the check (${stepUpError}). Nothing was recorded and the refund is still waiting. You are still signed in. Approving a refund needs a passkey or security key on this device.`,
      "bad",
    );
  }
  // Replay what a real Auth0 re-authentication interrupted.
  if (resuming)
    view.replaceChildren(
      loader("Back from Auth0. Recording your decision…", true),
    );
  try {
    const resumed = await api.resumePending();
    if (resumed?.kind === "decision") {
      const r = resumed.result;
      section = "reviews";
      if (r.ok && r.decision === "approve" && r.operationId) {
        // Straight back to the agent, which redeems the approval over MCP.
        section = "agent";
        ctx.agentPrompt = handBack(r.operationId);
      }
      ctx.flash(
        r.ok
          ? `Back from Auth0. ${r.message}`
          : `Back from Auth0, but the service refused the decision${r.code ? ` (${r.code})` : ""}: ${r.message}`,
        r.ok ? "ok" : "bad",
      );
    }
  } catch (e) {
    ctx.flash(
      `Could not resume after re-authenticating: ${(e as Error).message}`,
      "bad",
    );
  }
  await render();
}

boot().catch((e) => {
  app.replaceChildren(
    h(
      "div",
      { class: "onboard" },
      errorPanel(
        e,
        { relogin: () => void auth.login() } as unknown as Ctx,
        () => location.reload(),
      ),
    ),
  );
});
