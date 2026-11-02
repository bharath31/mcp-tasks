import { useCallback, useEffect, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Fingerprint,
  ShieldCheck,
} from "lucide-react";
import {
  ApprovalError,
  needsStepUp,
  type ApprovalClient,
  type ApprovalView,
  type Decision,
} from "./api.js";
import { Badge, Button, Card, CopyValue, type Tone } from "./ui.js";

export type ApprovalMessages = {
  loading: string;
  ownerTitle: string;
  reviewerTitle: string;
  ownerHint: string;
  reviewerHint: string;
  claim: string;
  claimed: string;
  approve: string;
  reject: string;
  confirm: (decision: Decision) => string;
  confirmHint: string;
  recorded: (status: string) => string;
  refused: (message: string) => string;
  stepUpNote: string;
  sessionNote: string;
  back: string;
  unavailableTitle: string;
  unavailableHint: string;
  ownerContinues: string;
};

export const defaultApprovalMessages: ApprovalMessages = {
  loading: "Loading the operation…",
  ownerTitle: "Your agent is asking for approval",
  reviewerTitle: "Approval requested",
  ownerHint: "Check the details. Your agent continues only after you approve.",
  reviewerHint: "Claim this item before deciding.",
  claim: "Claim item",
  claimed: "Item claimed. Review the full operation before deciding.",
  approve: "Approve",
  reject: "Reject",
  confirm: (d) => `Confirm ${d}`,
  confirmHint:
    "Identity confirmed for this exact operation. Confirm to record your decision.",
  recorded: (s) => `Recorded: ${s}.`,
  refused: (m) => `Refused: ${m}`,
  stepUpNote:
    "Approving asks you to confirm with your passkey or device. The confirmation is bound to this exact operation.",
  sessionNote:
    "Routine decisions use your verified review session; nothing else is authorized.",
  back: "Back to queue",
  ownerContinues: "Your agent can continue now.",
  unavailableTitle: "This approval isn't available to you",
  unavailableHint:
    "It may have expired, been decided, or need a different approver. Task Authority answers the same way in each case.",
};

export type OperationApprovalProps = {
  approvalId: string;
  client: ApprovalClient;
  /** Redirects for a fresh step-up bound to this approval (challenge + login, or PAR). */
  stepUp: (view: ApprovalView, decision: Decision) => Promise<void>;
  /** Set after the step-up redirect returns, to offer the final confirmation. */
  resumed?: { decision: Decision; digest: string } | null;
  messages?: Partial<ApprovalMessages>;
  backHref?: string;
  onDecided?: (view: ApprovalView, status: string) => void;
};

const STATUS_TONE: Record<string, Tone> = {
  pending: "pending",
  approved: "success",
  rejected: "danger",
  expired: "neutral",
};

/** One approval, rendered from Task Authority's own record, decided in place. */
export function OperationApproval(props: OperationApprovalProps) {
  const m = { ...defaultApprovalMessages, ...props.messages };
  const { client, approvalId } = props;
  const [view, setView] = useState<ApprovalView | null>(null);
  const [status, setStatus] = useState(m.loading);
  const [error, setError] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // A refused confirmation is spent: offer the decision again instead of the same token.
  const [spent, setSpent] = useState(false);
  const fail = (e: unknown) => {
    setError(true);
    setStatus(
      e instanceof ApprovalError || e instanceof Error
        ? e.message
        : "Request failed",
    );
  };

  const load = useCallback(async () => {
    try {
      const v = await client.get(approvalId);
      setView(v);
      setError(false);
      setStatus(
        v.status !== "pending"
          ? `Approval ${v.status}.`
          : v.viewerRole === "owner"
            ? m.ownerHint
            : m.reviewerHint,
      );
    } catch (e) {
      fail(e);
    }
  }, [client, approvalId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function record(decision: Decision, digest: string) {
    try {
      const r = await client.decide(approvalId, decision, digest);
      setError(false);
      setDone(r.status);
      setStatus(
        m.recorded(r.status) +
          (view?.viewerRole === "owner" && r.status === "approved"
            ? ` ${m.ownerContinues}`
            : ""),
      );
      if (view) props.onDecided?.(view, r.status);
    } catch (e) {
      setSpent(true);
      fail(e instanceof ApprovalError ? new Error(m.refused(e.message)) : e);
    }
  }
  async function decide(decision: Decision) {
    if (!view) return;
    if (decision === "approve" && needsStepUp(view))
      return props.stepUp(view, decision).catch(fail);
    return record(decision, view.operationDigest);
  }

  if (!view)
    return (
      <Card className="ta-approval">
        {error ? (
          <div className="ta-unavailable">
            <div className="ta-unavailable-icon">
              <CircleAlert size={18} />
            </div>
            <h2>{m.unavailableTitle}</h2>
            <p className="ta-muted">{m.unavailableHint}</p>
          </div>
        ) : null}
        <StatusLine text={status} error={error} />
        <div className="ta-pad" />
      </Card>
    );

  const op = view.operation;
  const owner = view.viewerRole === "owner";
  const resumed =
    !spent && props.resumed && props.resumed.digest === view.operationDigest
      ? props.resumed
      : null;
  const pending = view.status === "pending" && !done;
  const amount = formatAmount(op?.arguments);

  return (
    <Card className="ta-approval">
      <header className="ta-approval-head">
        <div className="ta-eyebrow">
          {owner ? <Fingerprint size={14} /> : <ShieldCheck size={14} />}
          {owner ? m.ownerTitle : m.reviewerTitle}
        </div>
        <Badge tone={STATUS_TONE[done ?? view.status] ?? "neutral"}>
          {done ?? view.status}
        </Badge>
      </header>

      <div className="ta-hero">
        {amount ? <div className="ta-amount">{amount}</div> : null}
        <div className="ta-action">
          <code className="ta-pill">{op?.action ?? "operation"}</code>
          <span className="ta-muted">on</span>
          <span className="ta-resource">{op?.resource}</span>
        </div>
      </div>

      <dl className="ta-fields">
        {Object.entries(op?.arguments ?? {}).map(([key, value]) => (
          <div className="ta-field" key={key}>
            <dt>{key}</dt>
            <dd>
              {typeof value === "object"
                ? JSON.stringify(value)
                : String(value)}
            </dd>
          </div>
        ))}
        <div className="ta-field">
          <dt>Organization</dt>
          <dd>{op?.organizationId}</dd>
        </div>
        <div className="ta-field">
          <dt>Expires</dt>
          <dd>
            <Clock size={13} className="ta-inline-icon" />
            {relative(view.expiresAt)}
          </dd>
        </div>
        <div className="ta-field">
          <dt>Operation digest</dt>
          <dd>
            <CopyValue value={view.operationDigest} label="operation digest" />
          </dd>
        </div>
      </dl>

      <StatusLine text={status} error={error} done={done} />

      <footer className="ta-actions">
        {!pending ? (
          props.backHref ? (
            <a className="ta-btn ta-btn-secondary" href={props.backHref}>
              {m.back}
            </a>
          ) : null
        ) : resumed ? (
          <>
            <p className="ta-note">{m.confirmHint}</p>
            <Button
              variant="primary"
              icon={<CircleCheck size={15} />}
              onClick={() => record(resumed.decision, resumed.digest)}
            >
              {m.confirm(resumed.decision)}
            </Button>
          </>
        ) : !owner && !claimed ? (
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await client.lease(view.id);
                setClaimed(true);
                setError(false);
                setStatus(m.claimed);
              } catch (e) {
                fail(e);
              }
            }}
          >
            {m.claim}
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              icon={<CircleX size={15} />}
              onClick={() => decide("reject")}
            >
              {m.reject}
            </Button>
            <Button
              variant="primary"
              icon={<CircleCheck size={15} />}
              onClick={() => decide("approve")}
            >
              {m.approve}
            </Button>
          </>
        )}
      </footer>
      {pending ? (
        <p className="ta-footnote">
          {needsStepUp(view) ? m.stepUpNote : m.sessionNote}
        </p>
      ) : null}
    </Card>
  );
}

function StatusLine(props: {
  text: string;
  error?: boolean;
  done?: string | null;
}) {
  return (
    <p
      id="status"
      role="status"
      aria-live="polite"
      className={
        props.error
          ? "ta-status ta-status-error"
          : props.done
            ? "ta-status ta-status-done"
            : "ta-status"
      }
    >
      {props.error ? <CircleAlert size={15} /> : null}
      {props.done ? <CircleCheck size={15} /> : null}
      <span>{props.text}</span>
    </p>
  );
}

/** "$150.00" for `{amountMinor, currency}` arguments; null for anything else. */
export function formatAmount(args?: Record<string, unknown>) {
  const minor = args?.amountMinor;
  const currency = args?.currency;
  if (typeof minor !== "number" || typeof currency !== "string") return null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(minor / 100);
  } catch {
    return null;
  }
}

export function relative(iso: string, now = Date.now()) {
  const ms = new Date(iso).getTime() - now;
  const min = Math.round(Math.abs(ms) / 60_000);
  const span =
    min < 1
      ? "less than a minute"
      : min < 90
        ? `${min} min`
        : `${Math.round(min / 60)} h`;
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}
