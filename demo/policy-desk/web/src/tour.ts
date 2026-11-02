// The guided tour's steps and how it advances. No imports, so tests can load it directly.

/** Mirrors Section in ctx.ts. */
type Section = "agent" | "reviews" | "policy" | "audit" | "glossary";

export type StepId =
  "signin" | "policy" | "small" | "large" | "review" | "audit" | "change";

export type Step = {
  id: StepId;
  title: string;
  what: string;
  doThis: string;
  go: Section;
  cta: string;
};

export const STEPS: Step[] = [
  {
    id: "signin",
    title: "Sign in with Auth0",
    what: "You signed in with Auth0 Universal Login. Your token, not a demo switch, authorizes everything that follows.",
    doThis: "Done once you are signed in.",
    go: "agent",
    cta: "Open the agent",
  },
  {
    id: "policy",
    title: "Read the policy",
    what: "One document decides what the agent can do alone and what needs a person.",
    doThis: "Open Policy and skim the rules and tiers.",
    go: "policy",
    cta: "Open Policy",
  },
  {
    id: "small",
    title: "The agent asks for a small refund",
    what: "Tell the agent what the customer needs. A $40 refund is inside its daily budget, so policy allows it with no person.",
    doThis: "Ask the agent to refund Dana $40 for her torn jacket.",
    go: "agent",
    cta: "Open the agent",
  },
  {
    id: "large",
    title: "The agent asks for a larger one",
    what: "A $139 refund is above the agent's auto-allow limit. Policy holds it for a human, whatever the model wants.",
    doThis: "Ask the agent to refund Mei's keyboard in full.",
    go: "agent",
    cta: "Open the agent",
  },
  {
    id: "review",
    title: "Review and approve",
    what: "You are the reviewer. Read the refund and approve it: that claims it, records your decision and hands it back to the agent. If Auth0 needs stronger proof it sends you to re-authenticate first.",
    doThis: "Read the refund, then approve it.",
    go: "reviews",
    cta: "Open Reviews",
  },
  {
    id: "audit",
    title: "Read the audit trail",
    what: "See every state change with who caused it and under which policy, plus the agent's MCP requests and responses.",
    doThis: "Open the approved operation's timeline.",
    go: "audit",
    cta: "Open Audit",
  },
  {
    id: "change",
    title: "Change the policy",
    what: "Raise or lower a limit, check it with the service, publish it, and see the next request decided differently.",
    doThis: "Edit a number, then publish and activate.",
    go: "policy",
    cta: "Open Policy",
  },
];

/**
 * The tour only moves forward: the next step is the first one after the furthest step
 * already done that is neither done nor skipped. When none is left the tour is finished,
 * even if an earlier step was never done; it never jumps back to one.
 */
export function nextStep(
  done: Record<StepId, boolean>,
  skips: StepId[],
): Step | undefined {
  const lastDone = Math.max(
    ...STEPS.map((s, i) => (done[s.id] && s.id !== "signin" ? i : 0)),
  );
  return STEPS.find(
    (s, i) => i > lastDone && !done[s.id] && !skips.includes(s.id),
  );
}
