import { useEffect, useState } from "react";
import { ChevronRight, Inbox } from "lucide-react";
import type { ApprovalClient, ApprovalView } from "./api.js";
import { formatAmount, relative } from "./OperationApproval.js";
import { Badge, Button, Card } from "./ui.js";

export type ApprovalQueueProps = {
  client: ApprovalClient;
  /** Link to one approval's page. */
  href: (view: ApprovalView) => string;
  /** When set, several same-action items can be confirmed in one WebAuthn ceremony. */
  batch?: {
    max: number;
    confirm: (views: ApprovalView[]) => Promise<void>;
  };
};

/** The signed-in person's eligible pending approvals, as Task Authority filters them. */
export function ApprovalQueue(props: ApprovalQueueProps) {
  const [items, setItems] = useState<ApprovalView[] | null>(null);
  const [status, setStatus] = useState("Loading approvals…");
  const [selected, setSelected] = useState<ApprovalView[]>([]);
  useEffect(() => {
    props.client
      .pending()
      .then((list) => {
        setItems(list);
        setStatus(
          `${list.length} eligible approval${list.length === 1 ? "" : "s"} awaiting review.`,
        );
      })
      .catch((e) =>
        setStatus(e instanceof Error ? e.message : "Approvals unavailable"),
      );
  }, [props.client]);

  const toggle = (view: ApprovalView, on: boolean) => {
    if (!on) return setSelected((s) => s.filter((v) => v.id !== view.id));
    const first = selected[0];
    if (
      selected.length >= (props.batch?.max ?? 0) ||
      (first &&
        (first.operation?.action !== view.operation?.action ||
          first.operation?.organizationId !== view.operation?.organizationId))
    )
      return setStatus(
        `Choose up to ${props.batch?.max} operations for the same action and organization.`,
      );
    setSelected((s) => [...s, view]);
  };

  return (
    <Card className="ta-queue">
      <header className="ta-queue-head">
        <div>
          <h2>Pending approvals</h2>
          <p id="status" role="status" className="ta-muted">
            {status}
          </p>
        </div>
        <a className="ta-btn ta-btn-secondary" href="?">
          Refresh
        </a>
      </header>
      {items && items.length === 0 ? (
        <div className="ta-empty">
          <Inbox size={20} />
          <p>Nothing is waiting for you.</p>
        </div>
      ) : (
        <ul className="ta-rows">
          {(items ?? []).map((view) => {
            const op = view.operation;
            const batchable =
              props.batch && view.assurance?.assurance !== "session_mfa";
            return (
              <li className="ta-row" key={view.id}>
                {batchable ? (
                  <input
                    type="checkbox"
                    aria-label={`Include ${view.id} in confirmation`}
                    checked={selected.some((v) => v.id === view.id)}
                    onChange={(e) => toggle(view, e.target.checked)}
                  />
                ) : null}
                <a className="ta-row-link" href={props.href(view)}>
                  <span className="ta-row-main">
                    <span className="ta-row-title">
                      {formatAmount(op?.arguments) ?? op?.action}
                      {view.viewerRole === "owner" ? (
                        <Badge tone="info">Your agent</Badge>
                      ) : null}
                    </span>
                    <span className="ta-row-sub">
                      <code>{op?.action}</code> · {op?.resource} · requested{" "}
                      {relative(view.requestedAt)}
                    </span>
                  </span>
                  <span className="ta-row-cta">
                    {view.viewerRole === "owner"
                      ? "Review"
                      : "Review and claim"}{" "}
                    <ChevronRight size={15} />
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {props.batch ? (
        <footer className="ta-actions">
          <Button
            variant="primary"
            disabled={!selected.length}
            onClick={() =>
              props
                .batch!.confirm(selected)
                .catch((e) =>
                  setStatus(e instanceof Error ? e.message : "Request failed"),
                )
            }
          >
            Confirm selected items with WebAuthn
          </Button>
        </footer>
      ) : null}
    </Card>
  );
}
