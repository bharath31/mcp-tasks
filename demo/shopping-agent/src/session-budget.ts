/** Wall-clock session budget shared by the agent loop and browser waits. */
export type SessionBudget = {
  readonly deadlineMs: number;
  readonly now: () => number;
};

export class SessionBudgetExceededError extends Error {
  constructor(message = "session time budget exhausted") {
    super(message);
    this.name = "SessionBudgetExceededError";
  }
}

export function createSessionBudget(
  startedMs: number,
  sessionTimeoutMs: number,
  now: () => number = Date.now,
): SessionBudget {
  return { deadlineMs: startedMs + sessionTimeoutMs, now };
}

export function assertWithinBudget(budget: SessionBudget): void {
  if (budget.now() > budget.deadlineMs) {
    throw new SessionBudgetExceededError();
  }
}

export function remainingBudgetMs(budget: SessionBudget): number {
  return Math.max(0, budget.deadlineMs - budget.now());
}

export function capWaitMs(budget: SessionBudget, requestedMs: number): number {
  assertWithinBudget(budget);
  const remaining = remainingBudgetMs(budget);
  if (remaining === 0) {
    throw new SessionBudgetExceededError();
  }
  return Math.min(requestedMs, remaining);
}