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

/**
 * Host-side wait bound for promises that may never settle (model RPC, browser launch).
 * Does **not** cancel the underlying provider work when the budget wins the race.
 */
export async function raceWithSessionBudget<T>(
  budget: SessionBudget,
  work: Promise<T>,
): Promise<T> {
  assertWithinBudget(budget);
  const remaining = remainingBudgetMs(budget);
  if (remaining === 0) {
    throw new SessionBudgetExceededError();
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new SessionBudgetExceededError());
    }, remaining);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** Close and discard a browser session if it resolves after the host gave up waiting. */
export function discardLateBrowserSession(
  launch: Promise<{ close(): Promise<void> }>,
): void {
  void launch
    .then(async (session) => {
      try {
        await session.close();
      } catch {
        /* late session cleanup */
      }
    })
    .catch(() => {});
}

/** Swallow a late model RPC result after the host already stopped waiting. */
export function discardLateModelRun(run: Promise<unknown>): void {
  void run.catch(() => {});
}