import { GLOSSARY } from "./glossary";
import { clear, h, pageHead, panel, purpose } from "./dom";

export function mountGlossary(el: HTMLElement) {
  clear(el);
  el.append(
    pageHead(
      "Glossary",
      "How a refund is decided, and every term in the sandbox.",
    ),
    panel(
      h("h2", {}, "How a refund is decided"),
      purpose(
        "Four steps, always in this order. The order is real: each step can stop the next.",
      ),
      h(
        "ol",
        { class: "life" },
        h(
          "li",
          {},
          h("b", {}, "The agent asks."),
          " It registers the exact operation with the service and gets a decision.",
        ),
        h(
          "li",
          {},
          h("b", {}, "Policy decides."),
          " Allow, require approval, require step-up, or deny, using the facts the caller supplied.",
        ),
        h(
          "li",
          {},
          h("b", {}, "A person approves."),
          " Only for approvals. The decision is bound to the operation digest and checked against your Auth0 session.",
        ),
        h(
          "li",
          {},
          h("b", {}, "The claim executes."),
          " The agent redeems the approval once, and the simulated payment runs.",
        ),
      ),
    ),
    panel(
      h("h2", {}, "Glossary"),
      purpose("Every badge and tier in the sandbox, in plain words."),
      h(
        "dl",
        { class: "glossary" },
        // Two keys can share one entry (deny and denied); list each entry once.
        ...[...new Set(Object.values(GLOSSARY))].flatMap((g) => [
          h("dt", {}, g.term),
          h("dd", {}, g.text),
        ]),
      ),
    ),
  );
}
