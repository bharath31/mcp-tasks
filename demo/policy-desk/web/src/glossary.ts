// Plain-language definitions. Used for hover/focus explanations and the Glossary tab.
// The policy outcome "deny" and the operation state "denied" are one idea: one entry.
const DENIED = {
  term: "Denied",
  text: "Policy refuses this operation when it is registered. No one can approve it. An action the policy does not list is denied by default.",
};
export const GLOSSARY: Record<string, { term: string; text: string }> = {
  allow: {
    term: "Allowed",
    text: "Policy let the agent act without a person. The refund ran inside its rules, here a daily budget.",
  },
  approve: {
    term: "Approval required",
    text: "Policy says a person must approve this exact operation before it can run. The agent waits.",
  },
  step_up: {
    term: "Step-up required",
    text: "The caller must prove more about who they are, for example a fresh multi-factor sign-in, before the service will continue.",
  },
  deny: DENIED,
  routine: {
    term: "Routine tier",
    text: "Approvals below the high-value threshold. One reviewer confirms this exact refund with a fresh passkey or security key.",
  },
  high_value: {
    term: "High-value tier",
    text: "Higher-risk approvals. You must re-authenticate with Auth0 for each decision, so a stolen session cannot approve them.",
  },
  session_mfa: {
    term: "Session MFA",
    text: "You completed multi-factor authentication when you signed in, and it is recent enough for this tier.",
  },
  per_operation: {
    term: "Per-operation confirmation",
    text: "A fresh Auth0 re-authentication tied to this decision. The service checks the time and the factor in your token.",
  },
  digest: {
    term: "Operation digest",
    text: "A hash of the exact request. Your approval is bound to it, so a changed amount or order cannot ride on an old approval.",
  },
  lease: {
    term: "Claim (lease)",
    text: "A short hold on an approval so two reviewers do not decide the same item. It expires on its own.",
  },
  quorum: {
    term: "Quorum",
    text: "The number of different approvers a policy requires before the operation is approved.",
  },
  budget: {
    term: "Budget",
    text: "A spending and count limit per agent over a time window. A request inside it can be allowed without a person.",
  },
  rule: {
    term: "Rule id",
    text: "The policy rule that matched. Every matched rule contributes. Deny wins, then approval, step-up, allow.",
  },
  policy_version: {
    term: "Policy version",
    text: "Policies are immutable versions. An operation keeps the version it was decided under, even if the policy changes later.",
  },
  sod: {
    term: "Separation of duties",
    text: "Whoever starts an operation cannot approve it. The service enforces this, not the interface.",
  },
  dpop: {
    term: "DPoP",
    text: "Your access token is bound to a key held by this browser, so a copied token is useless elsewhere.",
  },
  pending_approval: {
    term: "Pending",
    text: "Waiting for a reviewer to decide.",
  },
  approved: {
    term: "Approved",
    text: "A reviewer approved. The agent may now claim and run the operation once.",
  },
  rejected: {
    term: "Rejected",
    text: "A reviewer refused. The operation can never run.",
  },
  completed: {
    term: "Completed",
    text: "The operation ran. In this sandbox the payment is simulated.",
  },
  cancelled: {
    term: "Cancelled",
    text: "Withdrawn before any money moved, for example by MCP tasks/cancel. It can no longer run, even if a reviewer approves later.",
  },
  reconciling: {
    term: "Reconciling",
    text: "The refund was dispatched but its outcome was not confirmed. The next attempt looks the payment up by its key instead of paying again.",
  },
  denied: DENIED,
  transports: {
    term: "One guard, any transport",
    text: "MCP, REST and a command line all call the same guard at the resource server, so one request gets one decision whichever channel or client carries it.",
  },
};
