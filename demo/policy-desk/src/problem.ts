// Uniform, machine-readable refusals for the UI: every blocked action carries a
// stable `reason` code, a plain-language `message`, a `hint` and a `nextAction`.
export type ProblemExtra = {
  hint?: string;
  nextAction?: string;
  retryAfterSec?: number;
} & Record<string, unknown>;

export const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });

export class Guardrail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: ProblemExtra = {},
  ) {
    super(message);
  }
}
export function problem(
  status: number,
  code: string,
  message: string,
  extra: ProblemExtra = {},
) {
  const { retryAfterSec, ...rest } = extra;
  return json(
    {
      error: code,
      reason: code,
      message,
      hint: rest.hint ?? null,
      nextAction: rest.nextAction ?? null,
      ...rest,
      ...(retryAfterSec ? { retryAfterSec } : {}),
    },
    status,
    retryAfterSec ? { "retry-after": String(retryAfterSec) } : {},
  );
}
export const fromGuardrail = (g: Guardrail) =>
  problem(g.status, g.code, g.message, g.extra);

/** Plain-language mapping for Task Authority error codes surfaced through the customer REST path. */
export const REASONS: Record<
  string,
  { message: string; hint: string; nextAction: string }
> = {
  quota_exceeded: {
    message:
      "This sandbox already has the maximum number of pending approvals.",
    hint: "Approve or reject a pending request first.",
    nextAction: "open_review_queue",
  },
  rate_limited: {
    message: "Too many requests in a short time.",
    hint: "Wait a few seconds.",
    nextAction: "retry_later",
  },
  invalid_identity: {
    message: "Your Auth0 access token was missing or rejected.",
    hint: "Sign in again.",
    nextAction: "sign_in",
  },
  not_authorized: {
    message: "You are not allowed to do this in this sandbox.",
    hint: "Check the reason code; separation of duties and approver rights are enforced.",
    nextAction: "none",
  },
  approver_ineligible: {
    message: "You cannot approve this request.",
    hint: "You cannot approve a request you initiated, and approvers need the refund_approve relation.",
    nextAction: "use_other_reviewer",
  },
  delegation_ceiling_exceeded: {
    message: "The agent delegation does not allow this.",
    hint: "The agent's delegation limits actions and amounts.",
    nextAction: "none",
  },
  action_outside_delegation: {
    message: "The agent was never delegated this action.",
    hint: "Only refund actions listed in the delegation are available to the agent.",
    nextAction: "none",
  },
};
