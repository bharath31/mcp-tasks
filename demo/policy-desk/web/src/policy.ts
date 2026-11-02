import type { Ctx } from "./ctx";
import {
  badge,
  clear,
  h,
  json,
  money,
  pageHead,
  panel,
  put,
  term,
} from "./dom";
import { confirmDialog } from "./dialog";
import { mountError } from "./ui";
import type {
  NumericPolicyKey,
  PolicySettings,
  PolicyView,
  SimulationResult,
} from "./types";

export const VIEWED_POLICY = "pd.viewed.policy";

type Key = NumericPolicyKey;
const FIELDS: {
  key: Key;
  label: string;
  help: string;
  unit: "usd" | "count";
}[] = [
  {
    key: "agentAutoLimitMinor",
    label: "Auto-allow up to (USD)",
    help: "Agent refunds at or below this amount can run without a person, while budget remains.",
    unit: "usd",
  },
  {
    key: "budgetMaxMinor",
    label: "Daily budget per agent (USD)",
    help: "The most the agent can auto-refund in 24 hours.",
    unit: "usd",
  },
  {
    key: "budgetMaxCount",
    label: "Daily refunds per agent",
    help: "The most auto-allowed refunds in 24 hours.",
    unit: "count",
  },
  {
    key: "highValueAboveMinor",
    label: "High-value above (USD)",
    help: "Refunds above this amount need a fresh re-authentication for each decision.",
    unit: "usd",
  },
];

const toUi = (f: (typeof FIELDS)[number], minor: number) =>
  f.unit === "usd" ? minor / 100 : minor;
const toWire = (f: (typeof FIELDS)[number], v: number) =>
  f.unit === "usd" ? Math.round(v * 100) : v;
const fmt = (f: (typeof FIELDS)[number], minor: number) =>
  f.unit === "usd" ? money(minor) : String(minor);

export async function mountPolicy(el: HTMLElement, ctx: Ctx) {
  clear(el);
  let view: PolicyView;
  try {
    view = await ctx.api.policy();
  } catch (e) {
    mountError(el, e, ctx, () => void mountPolicy(el, ctx));
    return;
  }
  try {
    sessionStorage.setItem(VIEWED_POLICY, "1");
  } catch {
    /* optional */
  }
  ctx.changed();

  const current: PolicySettings = {
    ...view.settings,
    allowAuthenticatorApp: view.settings.allowAuthenticatorApp === true,
  };
  const form: PolicySettings = { ...current };
  const appChanged = () =>
    form.allowAuthenticatorApp !== current.allowAuthenticatorApp;
  const appLine = (on: boolean | undefined) =>
    on
      ? "passkey, security key or authenticator app"
      : "passkey or security key";

  const restoreBtn = h(
    "button",
    {
      class: "btn small",
      type: "button",
      onclick: async () => {
        try {
          const v = await ctx.api.restorePolicy();
          ctx.flash(`Default policy restored${v ? ` as ${v}` : ""}.`, "ok");
          ctx.changed();
          await mountPolicy(el, ctx);
        } catch (e) {
          ctx.flash((e as Error).message, "bad");
        }
      },
    },
    "Restore default",
  );
  const head = pageHead(
    "Policy",
    "What the agent may do alone and what needs a person.",
    restoreBtn,
  );

  const cel = h(
    "button",
    {
      class: "btn small ghost",
      type: "button",
      "aria-pressed": "false",
      onclick: () => {
        const on = !readable.classList.contains("show-cel");
        readable.classList.toggle("show-cel", on);
        cel.setAttribute("aria-pressed", String(on));
        cel.textContent = on ? "Hide conditions" : "Show conditions";
      },
    },
    "Show conditions",
  );
  const readable = panel(
    h(
      "div",
      { class: "row panel-title" },
      h("h2", {}, "Rules"),
      badge("allow", `${view.version} active`, "policy_version"),
      h("span", { class: "spacer" }),
      cel,
    ),
    h(
      "ul",
      { class: "rules" },
      ...view.summary.map((r) =>
        h(
          "li",
          { class: "rule" },
          h("p", {}, r.text),
          h(
            "div",
            { class: "row rule-meta" },
            term("rule", r.id),
            r.tier ? badge("info", r.tier.replace("_", " "), r.tier) : null,
          ),
          r.when
            ? h("code", { class: "when mono", title: "CEL condition" }, r.when)
            : null,
        ),
      ),
    ),
    h(
      "p",
      { class: "dim" },
      "Every matching rule applies and the strictest outcome wins. An action the policy does not list is denied.",
    ),
    h(
      "details",
      { class: "inline-fold" },
      h("summary", {}, "How rules are written"),
      h(
        "p",
        { class: "dim" },
        "Rules are a versioned JSON document with CEL conditions; the sentences above are a reading of them. Approvers, tiers and the default cannot be edited in this sandbox.",
      ),
      h("p", { class: "mono dim" }, view.resourceServer),
      view.document ? h("pre", {}, json(view.document)) : null,
    ),
  );

  const editor = panel(
    h("h2", {}, "Try a change"),
    h(
      "p",
      { class: "dim" },
      "Nothing changes until you publish. New versions apply to new requests only.",
    ),
  );
  const grid = h("div", { class: "field-grid" });
  editor.append(grid);
  const out = h("div", { class: "stack" });
  const diff = h("div", {});
  const actions = h("div", { class: "row" });
  const reason = h("p", { class: "why" });
  const errs = new Map<Key, HTMLElement>();
  const limit =
    view.publishes?.max ?? ctx.info.limits.maxPolicyPublishesPerHour;
  const publishNote = () =>
    view.publishes
      ? ` You have published ${view.publishes.used} of ${view.publishes.max} versions this hour.`
      : limit
        ? ` The sandbox allows ${limit} publishes per hour.`
        : "";
  const diffItems = () => [
    ...changed().map((f) =>
      h(
        "li",
        {},
        `${f.label.replace(" (USD)", "")}: `,
        h("s", {}, fmt(f, current[f.key])),
        " → ",
        h("b", {}, fmt(f, form[f.key])),
      ),
    ),
    ...(appChanged()
      ? [
          h(
            "li",
            {},
            "Routine approvals accept: ",
            h("s", {}, appLine(current.allowAuthenticatorApp)),
            " → ",
            h("b", {}, appLine(form.allowAuthenticatorApp)),
          ),
        ]
      : []),
  ];

  const fieldError = (
    f: (typeof FIELDS)[number],
    v: number,
  ): string | undefined => {
    const [lo, hi] = view.envelope[f.key];
    if (!Number.isFinite(v)) return "Enter a number.";
    if (f.unit === "count" && !Number.isInteger(v))
      return "Use a whole number.";
    const wire = toWire(f, v);
    if (wire < lo || wire > hi)
      return `Use a value from ${fmt(f, lo)} to ${fmt(f, hi)}.`;
    return undefined;
  };
  const changed = () => FIELDS.filter((f) => form[f.key] !== current[f.key]);

  function refreshUi() {
    clear(out);
    let bad: string | undefined;
    for (const f of FIELDS) {
      const msg = fieldError(f, toUi(f, form[f.key]));
      errs.get(f.key)!.textContent = msg ?? "";
      bad ??= msg;
    }
    const cross =
      form.highValueAboveMinor <= form.agentAutoLimitMinor
        ? "The high-value limit must be above the auto-allow limit."
        : undefined;
    bad ??= cross;
    const ch = [...changed(), ...(appChanged() ? ["app"] : [])];
    clear(diff);
    put(
      diff,
      h("h3", {}, "What will change"),
      ch.length
        ? h("ul", { class: "diff" }, ...diffItems())
        : h("p", { class: "dim" }, "No changes yet."),
      ch.length
        ? h(
            "p",
            { class: "dim" },
            "New requests will be decided under the new version. Requests already waiting keep the version they were registered under.",
          )
        : null,
    );
    if (cross)
      diff.append(h("p", { class: "notice bad", role: "alert" }, cross));
    clear(actions);
    const disabled = !ch.length || Boolean(bad);
    reason.textContent = !ch.length
      ? "Disabled: change at least one setting first."
      : bad
        ? `Disabled: ${bad}`
        : "";
    reason.hidden = !disabled;
    const autoChanged =
      form.agentAutoLimitMinor !== current.agentAutoLimitMinor;
    put(
      actions,
      autoChanged
        ? h(
            "button",
            {
              class: "btn",
              type: "button",
              disabled,
              onclick: () => void replay(),
            },
            "Replay against my operations",
          )
        : null,
      h(
        "button",
        {
          class: "btn primary",
          type: "button",
          disabled,
          "data-guide": "change",
          onclick: (e: Event) => confirmPublish(e.currentTarget as HTMLElement),
        },
        "Publish and activate",
      ),
    );
  }

  async function replay() {
    clear(out);
    try {
      const r: SimulationResult = await ctx.api.simulate(
        form.agentAutoLimitMinor,
      );
      put(
        out,
        h(
          "div",
          { class: "notice", role: "status" },
          h(
            "b",
            {},
            `${r.changed} of ${r.considered} recent operations would be decided differently. `,
          ),
          "Nothing was activated.",
        ),
        r.rows.length
          ? h(
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
                    h("th", {}, "Operation"),
                    h("th", {}, "Now"),
                    h("th", {}, "With change"),
                  ),
                ),
                h(
                  "tbody",
                  {},
                  ...r.rows.map((x) =>
                    h(
                      "tr",
                      {},
                      h("td", {}, x.summary),
                      h("td", { class: "mono" }, x.before),
                      h("td", { class: "mono" }, x.after),
                    ),
                  ),
                ),
              ),
            )
          : null,
      );
    } catch (e) {
      out.append(
        h(
          "div",
          { class: "notice bad", role: "alert" },
          h("b", {}, "Could not replay. "),
          (e as Error).message,
        ),
      );
    }
  }
  function confirmPublish(trigger: HTMLElement) {
    confirmDialog({
      trigger,
      title: "Publish and activate this version?",
      body: h(
        "div",
        { class: "stack" },
        h(
          "p",
          {},
          `It becomes the active policy for new refund requests right away. Waiting requests keep ${view.version}.${publishNote()}`,
        ),
        h("ul", { class: "diff" }, ...diffItems()),
        h(
          "p",
          { class: "dim" },
          "You can go back at any time with Restore default policy.",
        ),
      ),
      confirm: "Publish and activate",
      cancel: "Not yet",
      onConfirm: () => publish(),
    });
  }
  async function publish() {
    clear(out);
    try {
      const v = await ctx.api.savePolicy({
        ...(Object.fromEntries(
          changed().map((f) => [f.key, form[f.key]]),
        ) as Partial<PolicySettings>),
        ...(appChanged()
          ? { allowAuthenticatorApp: form.allowAuthenticatorApp }
          : {}),
      });
      ctx.flash(`${v || "New version"} is active.`, "ok");
      ctx.changed();
      await mountPolicy(el, ctx);
    } catch (e) {
      const a = e as { message: string; hint?: string; code?: string };
      out.append(
        h(
          "div",
          { class: "notice bad", role: "alert" },
          h("b", {}, `Not published${a.code ? ` (${a.code})` : ""}. `),
          a.message,
          a.hint ? ` ${a.hint}` : "",
        ),
      );
    }
  }

  for (const f of FIELDS) {
    const [lo, hi] = view.envelope[f.key];
    const inp = h("input", {
      type: "number",
      id: `f-${f.key}`,
      min: String(toUi(f, lo)),
      max: String(toUi(f, hi)),
      step: f.unit === "usd" ? "10" : "1",
      value: String(toUi(f, form[f.key])),
    });
    const er = h("p", { class: "why", id: `e-${f.key}` });
    errs.set(f.key, er);
    inp.setAttribute("aria-describedby", `e-${f.key}`);
    const onEdit = (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      form[f.key] = Number.isFinite(v) ? toWire(f, v) : NaN;
      refreshUi();
    };
    inp.addEventListener("input", onEdit);
    inp.setAttribute("aria-describedby", `h-${f.key} e-${f.key}`);
    grid.append(
      h(
        "div",
        { class: "field" },
        h("label", { for: `f-${f.key}` }, f.label),
        inp,
        h(
          "p",
          { class: "dim", id: `h-${f.key}`, title: f.help },
          `${fmt(f, lo)} to ${fmt(f, hi)}`,
        ),
        er,
      ),
    );
  }
  const app = h("input", {
    type: "checkbox",
    id: "f-allowAuthenticatorApp",
  }) as HTMLInputElement;
  app.checked = form.allowAuthenticatorApp === true;
  app.addEventListener("change", () => {
    form.allowAuthenticatorApp = app.checked;
    refreshUi();
  });
  editor.append(
    h(
      "div",
      { class: "field check" },
      h(
        "label",
        { for: "f-allowAuthenticatorApp" },
        app,
        " Accept authenticator apps for routine approvals",
      ),
      h(
        "p",
        { class: "dim" },
        "A demo setting for reviewers without a passkey device. High-value refunds always need a passkey. Off by default.",
      ),
    ),
  );
  editor.append(diff, h("div", { class: "stack" }, actions, reason));
  if (view.publishes) {
    const full = view.publishes.used >= view.publishes.max;
    editor.append(
      h(
        "p",
        { class: full ? "why" : "dim" },
        full
          ? `You have used all ${view.publishes.max} publishes for this hour. Try again later, or reset the sandbox.`
          : `Publishes this hour: ${view.publishes.used} of ${view.publishes.max}.`,
      ),
    );
  }
  editor.append(out);
  refreshUi();

  el.append(head, h("div", { class: "split even" }, readable, editor));
}
