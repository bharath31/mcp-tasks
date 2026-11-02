import { useState, type ReactNode } from "react";
import { Check, Copy, LoaderCircle } from "lucide-react";

export const cx = (...names: Array<string | false | null | undefined>) =>
  names.filter(Boolean).join(" ");

export function Button(props: {
  children: ReactNode;
  onClick?: () => Promise<void> | void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  icon?: ReactNode;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type={props.type ?? "button"}
      className={cx("ta-btn", `ta-btn-${props.variant ?? "secondary"}`)}
      disabled={busy || props.disabled}
      aria-busy={busy || undefined}
      onClick={async () => {
        if (!props.onClick) return;
        setBusy(true);
        try {
          await props.onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <LoaderCircle className="ta-spin" size={15} /> : props.icon}
      {props.children}
    </button>
  );
}

export type Tone = "neutral" | "pending" | "success" | "danger" | "info";
export const Badge = (props: { tone?: Tone; children: ReactNode }) => (
  <span className={cx("ta-badge", `ta-badge-${props.tone ?? "neutral"}`)}>
    <span className="ta-dot" aria-hidden="true" />
    {props.children}
  </span>
);

export function CopyValue(props: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="ta-copy">
      <code title={props.value}>{props.value}</code>
      <button
        type="button"
        className="ta-icon-btn"
        aria-label={`Copy ${props.label}`}
        onClick={async () => {
          await navigator.clipboard?.writeText(props.value).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </span>
  );
}

export const Card = (props: { children: ReactNode; className?: string }) => (
  <section className={cx("ta-card", props.className)}>{props.children}</section>
);
