import { ApiError } from "./types";

export type Recovery = "signin" | "retry" | "reset" | "none";
export type Explained = {
  title: string;
  body: string;
  recovery: Recovery;
  next?: string;
  /** Status, reason code and any operator hint. Shown behind "Technical details", never dropped. */
  detail?: string;
  /** Show `detail` openly. Refusal reason codes are part of what the demo teaches. */
  showDetail?: boolean;
};

const sentence = (s: string) =>
  /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`;

/** Turn a service error into what happened and what to do next, in plain language. Server codes go in `detail`. */
export function explain(err: unknown): Explained {
  if (err instanceof ApiError) {
    const next = err.nextAction;
    const detail =
      [
        [err.status ? `HTTP ${err.status}` : "", err.code]
          .filter(Boolean)
          .join(" · "),
        err.status >= 500 ? err.hint : "",
      ]
        .filter(Boolean)
        .join("\n") || undefined;
    const hint = err.hint && err.status < 500 ? ` ${sentence(err.hint)}` : "";
    const base = `${sentence(err.message)}${hint}`;
    if (
      err.status === 401 ||
      next === "sign_in" ||
      err.code === "session_expired"
    )
      return {
        title: "Your session expired",
        body: "Auth0 needs you to sign in again. Nothing you did was lost.",
        recovery: "signin",
        detail,
      };
    if (err.status === 429 || next === "retry_later")
      return {
        title: "Slow down for a moment",
        body: err.retryAfterSec
          ? `${base} You can try again in ${err.retryAfterSec} seconds.`
          : base,
        recovery: "retry",
        detail,
      };
    if (
      err.status === 410 ||
      next === "reset_sandbox" ||
      err.code === "sandbox_not_initialized"
    )
      return {
        title:
          err.code === "sandbox_not_initialized"
            ? "Your sandbox expired or was never created"
            : "Your sandbox needs a reset",
        body: base,
        recovery: "reset",
        detail,
      };
    if (err.status === 0)
      return {
        title: "Cannot reach the sandbox",
        body: sentence(err.message),
        recovery: "retry",
        detail,
      };
    if (err.code === "not_configured" || next === "contact_operator")
      return {
        title: "The sandbox is unavailable right now",
        body: "Part of the demo's Auth0 setup did not respond as expected. Nothing you did caused this, and nothing was created. Try again in a minute.",
        recovery: "retry",
        detail,
      };
    if (err.status >= 500)
      return {
        title: "Something went wrong on our side",
        body: `${base} Try again; if it keeps happening, reset your sandbox.`,
        recovery: "retry",
        detail,
      };
    return {
      title: "The service refused this",
      body: base,
      recovery: "none",
      next,
      detail: err.code,
      showDetail: Boolean(err.code),
    };
  }
  return {
    title: "Something went wrong",
    body: "The page hit an unexpected error. Try again.",
    recovery: "retry",
    detail: err instanceof Error ? err.message : String(err),
  };
}
