import type { Ctx } from "./ctx";
import {
  ago,
  badge,
  chip,
  clear,
  empty,
  h,
  kv,
  money,
  pageHead,
  panel,
  put,
  term,
  when,
} from "./dom";
import { confirmDialog } from "./dialog";
import { enter } from "./motion";
import { mountError } from "./ui";
import type { ApprovalItem, DecisionResult } from "./types";

/** What the agent is asked once its refund is approved; it then redeems the approval over MCP. */
export const handBack = (operationId: string) =>
  `Refund task ${operationId} was approved. Check on it and tell me what happened.`;

/** Above the default auto-allow limit and below high value, so policy holds it for a person. */
export const ASK_150 =
  "Kwame Mensah's noise-cancelling headphones arrived with a broken hinge. Refund him $150.";

function detail(it: ApprovalItem): HTMLElement {
  const o = it.operation;
  return kv(
    [
      ["Customer", o.customer ?? "not provided"],
      ["Item", o.item ?? "not provided"],
      ["Reason", o.reason ?? "not provided"],
      ["Requested by", o.requester],
      ["Registered", when(o.createdAt)],
    ],
    false,
  );
}

/** What a security reviewer checks, folded under the decision. */
function technical(it: ApprovalItem): HTMLElement {
  const o = it.operation;
  return kv([
    ["Action", o.action],
    ["Resource", o.resource],
    ["Policy version", o.policyVersion ?? "n/a"],
    ["Tier", it.tier],
    ["Digest", o.digest ?? it.digest],
  ]);
}

const hasWebAuthn = (amr: string[] | undefined) =>
  Boolean(amr?.some((x) => x.startsWith("webauthn")));

/** Says exactly what Auth0 and the service will require for this approval, before the visitor acts. */
function assuranceBlock(it: ApprovalItem, ctx: Ctx): HTMLElement {
  const hv = it.assurance === "per_operation";
  const amr = ctx.me.token?.amr;
  const block = h(
    "div",
    { class: "assure" },
    h("h3", {}, "What Auth0 will check when you approve"),
  );
  if (!hv) {
    put(
      block,
      h(
        "p",
        {},
        "This is a ",
        term("routine"),
        " approval. The service checks that your token shows multi-factor sign-in that is recent enough (",
        term("session_mfa"),
        "). If it is stale, Auth0 asks you to sign in again and your decision resumes.",
      ),
    );
  } else {
    put(
      block,
      h(
        "p",
        {},
        "This is a ",
        term(it.tier === "high_value" ? "high_value" : "routine"),
        " approval. Three things must hold:",
      ),
      h(
        "ol",
        { class: "checks" },
        h(
          "li",
          {},
          h("b", {}, "A challenge tied to this refund. "),
          "The service creates a one-time challenge bound to this approval, its digest, you and your browser's key.",
        ),
        it.appCodeAccepted
          ? h(
              "li",
              {},
              h("b", {}, "A fresh second factor. "),
              "Auth0 asks for your passkey, security key or a code from your authenticator app (or helps you set one up), and carries the challenge into your new token. Your sandbox's policy allows the app code for routine refunds; high-value refunds still need a passkey.",
            )
          : h(
              "li",
              {},
              h("b", {}, "A fresh WebAuthn sign-in. "),
              "Auth0 asks for your passkey or security key (or helps you create one), and carries the challenge into your new token.",
            ),
        h(
          "li",
          {},
          h("b", {}, "Then the decision. "),
          "The service checks the factor, the age of the sign-in and the challenge, and only then records your approval.",
        ),
      ),
      it.appCodeAccepted
        ? h(
            "div",
            { class: "notice", role: "note" },
            h("b", {}, "Authenticator apps are allowed for this refund. "),
            "This is a demo setting in your sandbox's policy, for devices without passkeys. The real default is a passkey for every approval.",
          )
        : !hasWebAuthn(amr)
          ? h(
              "div",
              { class: "notice warn", role: "note" },
              h("b", {}, "Approving opens Auth0 for a passkey. "),
              "Your sign-in used an email code, which never approves a refund. Auth0 asks for a passkey or security key next.",
              h(
                "details",
                {},
                h("summary", {}, "No passkey yet? What Auth0 will ask"),
                h(
                  "p",
                  {},
                  "No second factor at all: Auth0 goes straight to creating a passkey (Face ID, Touch ID, Windows Hello or your device PIN). That passkey approves this refund and every one after it.",
                ),
                h(
                  "p",
                  {},
                  "An authenticator app (such as Auth0 Guardian), push or SMS set up earlier: Auth0 first asks for one code or notification from it, because it only adds a new factor after you prove one you already have. The next screen creates the passkey. The code alone never approves anything.",
                ),
                h(
                  "p",
                  {},
                  "You do not enter the email code again while your Auth0 sign-in is still active; only the passkey step is fresh.",
                ),
                h(
                  "p",
                  {},
                  "No device that can hold a passkey? In Policy, turn on “Accept authenticator apps for routine approvals” and ask the agent again. That applies to new requests only, so this refund still needs a passkey; you can reject it.",
                ),
              ),
            )
          : h(
              "div",
              { class: "notice ok", role: "note" },
              h("b", {}, "Your token already carries a WebAuthn factor. "),
              "You will still re-authenticate, because each high-value approval needs its own fresh sign-in.",
            ),
      h(
        "p",
        { class: "dim" },
        "Approving several high-value refunds in one confirmation needs Auth0 PAR with Rich Authorization Requests, which this sandbox does not use. Each refund gets its own challenge.",
      ),
    );
  }
  put(
    block,
    h(
      "p",
      { class: "dim" },
      "Your token is ",
      term("dpop", "sender-constrained"),
      ", so the challenge only works from this browser.",
    ),
  );
  return block;
}

export async function mountReviewer(el: HTMLElement, ctx: Ctx) {
  clear(el);
  const intro = pageHead(
    "Reviews",
    "Refunds policy held for a person. You only see what you may decide, never your own requests.",
  );
  const listBox = h("div", {});
  const detailBox = h("div", {});
  el.append(
    intro,
    h("div", { class: "split review-split" }, listBox, detailBox),
  );

  let items: ApprovalItem[] = [];
  let selected: string | undefined = ctx.focusOp;
  let result: DecisionResult | undefined;
  let lastApprovedOp: string | undefined;

  async function refresh(autoSelect = true) {
    try {
      items = await ctx.api.queue();
    } catch (e) {
      mountError(listBox, e, ctx, () => void refresh());
      clear(detailBox);
      return;
    }
    if (
      selected &&
      !items.some((i) => i.id === selected || i.operation.id === selected)
    )
      selected = undefined;
    if (!selected && items.length && autoSelect) selected = items[0]!.id;
    const byOp = items.find((i) => i.operation.id === selected);
    if (byOp) selected = byOp.id;
    drawList();
    drawDetail(false);
  }

  function drawList() {
    clear(listBox);
    const p = panel(
      h(
        "h2",
        {},
        "Waiting",
        h("span", { class: "count" }, String(items.length)),
      ),
    );
    if (!items.length) {
      p.append(
        empty(
          "Nothing waiting",
          "Ask the agent for a refund that needs approval first.",
        ),
        h(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: () => {
              // Sends the request, not just the tab: the agent runs it on arrival.
              ctx.agentPrompt = ASK_150;
              ctx.go("agent");
            },
          },
          "Ask the agent for a $150 refund",
        ),
      );
    } else {
      const ul = h("ul", { class: "list" });
      for (const it of items) {
        const o = it.operation;
        ul.append(
          h(
            "li",
            {},
            h(
              "button",
              {
                class: "pick",
                type: "button",
                "data-approval": it.id,
                "aria-current": String(it.id === selected),
                onclick: () => {
                  selected = it.id;
                  result = undefined;
                  drawList();
                  drawDetail(true);
                },
              },
              h(
                "strong",
                {},
                `${money(o.amountMinor, o.currency)} · ${o.customer ?? o.resource}`,
              ),
              h(
                "span",
                { class: "row" },
                badge("info", it.tier.replace("_", " "), it.tier),
                h("span", { class: "dim" }, ago(o.createdAt)),
                it.lease
                  ? chip(
                      it.lease.mine
                        ? "claimed by you"
                        : "claimed by someone else",
                    )
                  : null,
              ),
            ),
          ),
        );
      }
      p.append(ul);
    }
    listBox.append(p);
  }

  function resultBlock(): HTMLElement | null {
    if (!result) return null;
    if (result.redirecting)
      return h(
        "div",
        { class: "notice", role: "status" },
        h("b", {}, "Working. "),
        result.message,
      );
    return result.ok
      ? h(
          "div",
          { class: "notice ok", role: "status" },
          h("b", {}, "Recorded. "),
          result.message,
          lastApprovedOp
            ? h(
                "div",
                { class: "row" },
                h(
                  "button",
                  {
                    class: "btn primary small",
                    type: "button",
                    onclick: () => {
                      ctx.agentPrompt = handBack(lastApprovedOp!);
                      ctx.go("agent");
                    },
                  },
                  "Tell the agent",
                ),
                h(
                  "span",
                  { class: "dim" },
                  "The agent polls its task over MCP and redeems the approval once. The payment is simulated.",
                ),
              )
            : null,
        )
      : h(
          "div",
          { class: "notice bad", role: "alert" },
          h("b", {}, `Refused${result.code ? ` (${result.code})` : ""}. `),
          result.message,
        );
  }

  function drawDetail(animate: boolean) {
    clear(detailBox);
    const it = items.find((i) => i.id === selected);
    if (!it) {
      detailBox.append(
        panel(
          h("h2", {}, "Operation"),
          items.length
            ? empty(
                "Select a refund",
                "Read the whole operation before you decide.",
              )
            : empty(
                "Nothing to review",
                "When the agent asks for something policy cannot allow, it appears here.",
              ),
          resultBlock(),
        ),
      );
      return;
    }
    const o = it.operation;
    const claimed = Boolean(it.lease?.mine);
    const heldByOther = Boolean(it.lease && !it.lease.mine);
    const hv = it.assurance === "per_operation";
    const amt = money(o.amountMinor, o.currency);
    const decide = async (
      decision: "approve" | "reject",
      btn: HTMLButtonElement,
      reason?: string,
    ) => {
      result = undefined;
      for (const b of detailBox.querySelectorAll<HTMLButtonElement>(
        ".decide button",
      ))
        b.disabled = true;
      btn.setAttribute("aria-busy", "true");
      // One click: claim first when nobody holds it, so no one else decides it at the same time.
      if (!it.lease) {
        btn.textContent = "Claiming…";
        try {
          await ctx.api.lease(it.id);
        } catch (e) {
          result = { ok: false, status: 0, message: (e as Error).message };
          await refresh();
          return;
        }
      }
      btn.textContent =
        decision === "approve"
          ? hv
            ? "Creating the challenge…"
            : "Approving…"
          : "Rejecting…";
      const r = await ctx.api
        .decide([
          {
            approvalId: it.id,
            operationId: o.id,
            decision,
            digest: it.digest,
            highValue: hv,
            appCodeAccepted: it.appCodeAccepted,
            ...(reason ? { reason } : {}),
          },
        ])
        .catch(
          (e) =>
            ({
              ok: false,
              status: 0,
              message: (e as Error).message,
            }) as DecisionResult,
        );
      result = r;
      if (r.redirecting) {
        btn.textContent = "Opening Auth0…";
        return;
      }
      ctx.changed();
      if (r.ok && decision === "approve") {
        // The agent redeems the approval with tasks/get; hand the conversation straight back.
        ctx.flash("Approved. The agent is picking the refund up now.", "ok");
        ctx.agentPrompt = handBack(o.id);
        ctx.go("agent");
        return;
      }
      if (r.ok) {
        // The agent's card shows its last tasks/get; a rejection ends that task, so say so there too.
        for (const key of [o.id, it.id]) {
          const run = ctx.runs.get(key);
          if (run?.task)
            ctx.runs.set(key, {
              ...run,
              task: {
                ...run.task,
                status: "failed",
                statusMessage: "Rejected by a reviewer. No money moved.",
                decision: { ...run.task.decision, decision: "deny" },
              },
            });
        }
        // Optimistic: the decision is recorded, so drop it from the queue before the reload lands.
        items = items.filter((x) => x.id !== it.id);
        selected = undefined;
        drawList();
        drawDetail(false);
      }
      lastApprovedOp = undefined;
      selected = r.ok ? undefined : it.id;
      await refresh(!r.ok);
    };
    const who = o.customer ? ` to ${o.customer}` : "";
    const digestShort = (it.digest ?? "").replace(/^sha256:/, "").slice(0, 12);
    const factorText = it.appCodeAccepted
      ? "your passkey, security key or authenticator-app code"
      : "your passkey or security key";
    // Leaving for Auth0: say what is being approved and what Auth0 will ask, since its
    // hosted screens cannot show this refund's details.
    const confirmApprove = (btn: HTMLButtonElement) => {
      if (!hv) return void decide("approve", btn);
      confirmDialog({
        trigger: btn,
        title: `Approve the ${amt} refund${who}?`,
        body: h(
          "div",
          { class: "stack" },
          kv([
            ["Amount", amt],
            ["Customer", o.customer ?? "not provided"],
            ["Item", o.item ?? "not provided"],
            ["Digest", `sha256:${digestShort}…`],
          ]),
          h(
            "p",
            {},
            `Next, Auth0 asks for ${factorText}. That check is bound to this refund and this digest only. If your Auth0 sign-in has ended, it asks for your email code first.`,
          ),
          h(
            "p",
            { class: "dim" },
            "Auth0's screens do not repeat the amount; this is the refund you are confirming.",
          ),
        ),
        confirm: "Continue to Auth0",
        cancel: "Not yet",
        onConfirm: () => decide("approve", btn),
      });
    };
    const confirmReject = (btn: HTMLButtonElement) => {
      const reasonInput = h("textarea", {
        id: "reject-reason",
        rows: "3",
        maxlength: "500",
        placeholder: "For example: duplicate of an earlier refund",
      }) as HTMLTextAreaElement;
      confirmDialog({
        trigger: btn,
        title: `Reject the ${amt} refund${who}?`,
        body: h(
          "div",
          { class: "stack" },
          h(
            "p",
            {},
            "The agent's task ends and no money moves. This cannot be undone; the agent would have to ask again.",
          ),
          h(
            "div",
            { class: "field" },
            h("label", { for: "reject-reason" }, "Reason (optional)"),
            reasonInput,
            h(
              "p",
              { class: "dim" },
              "Recorded in the audit trail with your decision.",
            ),
          ),
        ),
        confirm: "Reject refund",
        cancel: "Keep it waiting",
        danger: true,
        onConfirm: () =>
          decide("reject", btn, reasonInput.value.trim() || undefined),
      });
    };
    const why = "Someone else claimed this item. Wait for the claim to expire.";
    const assure = assuranceBlock(it, ctx);
    // The warning that Approve leaves for Auth0 stays in view; the explanation folds away.
    const warn = assure.querySelector<HTMLElement>(".notice");
    const card = panel(
      h(
        "div",
        { class: "row op-head" },
        h("div", { class: "amount" }, amt),
        h("span", { class: "spacer" }),
        badge("info", it.tier.replace("_", " "), it.tier),
        it.lease
          ? chip(
              claimed
                ? `Claimed by you until ${when(it.lease.expiresAt)}`
                : "Claimed by someone else",
            )
          : null,
      ),
      detail(it),
      warn,
      h(
        "div",
        { class: "row decide" },
        h(
          "button",
          {
            class: "btn primary",
            type: "button",
            disabled: heldByOther,
            "aria-describedby": heldByOther ? "why-approve" : "approve-what",
            "data-guide": "review",
            onclick: (e: Event) =>
              confirmApprove(e.currentTarget as HTMLButtonElement),
          },
          `Approve ${amt}`,
        ),
        h(
          "button",
          {
            class: "btn danger",
            type: "button",
            disabled: heldByOther,
            onclick: (e: Event) =>
              confirmReject(e.currentTarget as HTMLButtonElement),
          },
          "Reject",
        ),
      ),
      !heldByOther
        ? h(
            "p",
            { class: "dim", id: "approve-what" },
            hv
              ? it.appCodeAccepted || "PublicKeyCredential" in window
                ? "Approve sends you to Auth0 for a check bound to this refund, then finishes here. Reject needs no extra check."
                : "This browser cannot use a passkey or security key, so it cannot approve this refund. Reject still works."
              : "Approve claims the refund, records your decision bound to its digest, and hands it back to the agent.",
          )
        : h("p", { class: "why", id: "why-approve" }, `Disabled: ${why}`),
      resultBlock(),
      h(
        "div",
        { class: "folds" },
        h(
          "details",
          { class: "inline-fold" },
          h("summary", {}, "What Auth0 checks when you approve"),
          assure,
        ),
        h(
          "details",
          { class: "inline-fold" },
          h("summary", {}, "Technical details"),
          technical(it),
          h(
            "button",
            {
              class: "link",
              type: "button",
              onclick: () => ctx.go("audit", o.id),
            },
            "Open the audit timeline",
          ),
        ),
      ),
    );
    detailBox.append(card);
    if (animate) enter(card, { y: 6 });
  }

  await refresh();
}
