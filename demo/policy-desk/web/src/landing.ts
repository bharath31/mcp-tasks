import { aboutDemo, h } from "./dom";

const STEPS = [
  [
    "The agent asks",
    "A real model on Workers AI picks MCP tools and requests the refund you described.",
  ],
  [
    "Policy decides",
    "Allow, approval, step-up or deny, from facts like the amount and the agent's budget.",
  ],
  [
    "A person approves",
    "You approve that exact operation. Bigger refunds make Auth0 re-authenticate you.",
  ],
  [
    "The claim executes",
    "The agent redeems the approval once. The payment is simulated.",
  ],
] as const;

const REAL = [
  [
    "Real",
    "An LLM agent calling MCP tools with its own Auth0 machine identity. Auth0 Universal Login, multi-factor sign-in and step-up re-authentication. Sender-constrained tokens. A policy service that enforces separation of duties and records every change.",
  ],
  [
    "Simulated",
    "Only the payment. Refunds land in a payment simulator instead of Stripe; everything before the money moves is real.",
  ],
  [
    "Not a product",
    "Task Authority is a proposed design and reference implementation. It is not an Auth0 product, and nothing here is a shipped feature.",
  ],
] as const;

/** The logged-out page: what this is, how a refund is decided, what is real. */
export function landing(opts: {
  onSignIn(): void;
  error?: string;
}): HTMLElement {
  const blocked = Boolean(opts.error);
  const signIn = (label = "Sign in with Auth0", cls = "btn primary lg") =>
    h(
      "button",
      { class: cls, type: "button", onclick: opts.onSignIn, disabled: blocked },
      label,
    );
  return h(
    "div",
    { class: "landing" },
    h(
      "header",
      { class: "l-nav" },
      h(
        "span",
        { class: "l-brand" },
        h("span", { class: "wordmark" }, "Policy Desk"),
        aboutDemo(),
      ),
      h(
        "nav",
        { class: "l-links" },
        h("a", { class: "navlink", href: "#how" }, "How it works"),
        h("a", { class: "navlink", href: "#real" }, "What is real"),
        signIn("Sign in", "btn primary small"),
      ),
    ),
    h(
      "section",
      { class: "l-hero" },
      h(
        "p",
        { class: "eyebrow" },
        h("span", { class: "dot" }),
        "Reference implementation for MCP task approvals",
      ),
      h(
        "h1",
        {},
        h("span", { class: "ln" }, h("span", {}, "Agents ask.")),
        h("span", { class: "ln" }, h("span", {}, "People approve.")),
      ),
      h(
        "p",
        { class: "l-lead" },
        "Policy decides when an AI agent's refund needs a person. Your approval covers that exact operation.",
      ),
      opts.error
        ? h("p", { class: "l-error", role: "alert" }, opts.error)
        : null,
      h(
        "div",
        { class: "l-actions" },
        signIn(),
        h("a", { class: "btn lg", href: "#how" }, "How it works"),
      ),
      h(
        "p",
        { class: "l-note" },
        "Uses your own account on a real Auth0 tenant. No card, no money.",
      ),
      // An illustration of the design. It is labelled and never presented as live data.
      h(
        "figure",
        { class: "l-example", "data-ui": "" },
        h(
          "div",
          { class: "win-bar" },
          h("span", { class: "win-dots" }, h("i"), h("i"), h("i")),
          h("span", { class: "mono" }, "POST /v1/refunds  ·  $150.00"),
          h("span", { class: "badge approve" }, "Approval required"),
        ),
        h(
          "div",
          { class: "ex-grid" },
          h(
            "div",
            {},
            h("h3", {}, "REST"),
            h("div", { class: "big" }, "202"),
            h("p", { class: "dim mono" }, "Location: /v1/operations/…"),
          ),
          h(
            "div",
            {},
            h("h3", {}, "CLI"),
            h("div", { class: "big" }, "exit 0"),
            h("p", { class: "dim mono" }, "waitUrl set; --wait polls"),
          ),
          h(
            "div",
            {},
            h("h3", {}, "MCP"),
            h("div", { class: "big" }, "working"),
            h("p", { class: "dim mono" }, "Waiting for approval"),
          ),
        ),
        h(
          "figcaption",
          {},
          "Example of one $150 refund request, as the design reports it through three channels. Not live data.",
        ),
      ),
    ),
    h(
      "section",
      { class: "l-how", id: "how" },
      h(
        "div",
        { class: "l-head" },
        h("p", { class: "eyebrow plain" }, "How it works"),
        h("h2", {}, "A refund, in four steps"),
      ),
      h(
        "ol",
        { class: "l-cards" },
        ...STEPS.map(([title, body], i) =>
          h(
            "li",
            {},
            h("span", { class: "num mono" }, String(i + 1).padStart(2, "0")),
            h("strong", {}, title),
            h("span", {}, body),
          ),
        ),
      ),
    ),
    h(
      "section",
      { class: "l-real", id: "real" },
      h(
        "div",
        { class: "l-head" },
        h("p", { class: "eyebrow plain" }, "What is real"),
        h("h2", {}, "Real identity, simulated money"),
      ),
      h(
        "div",
        { class: "cols" },
        ...REAL.map(([title, body]) =>
          h("div", {}, h("h3", {}, title), h("p", {}, body)),
        ),
      ),
    ),
    h(
      "section",
      { class: "l-cta" },
      h("h2", {}, "See it decide a refund."),
      h(
        "p",
        {},
        "You will sign in, ask the agent for refunds, approve one, and change the policy. About three minutes.",
      ),
      signIn("Sign in and start"),
    ),
    h(
      "footer",
      { class: "l-foot" },
      h("span", { class: "wordmark" }, "Policy Desk"),
      h("span", {}, "A reference implementation of a proposed design"),
      h("span", {}, "Payments simulated"),
    ),
  );
}
