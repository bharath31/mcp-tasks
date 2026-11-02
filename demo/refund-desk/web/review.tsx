import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { Check, LogOut, ShieldCheck } from "lucide-react";
import {
  ApprovalQueue,
  Button,
  Card,
  OperationApproval,
  approvalClient,
  type ApprovalView,
  type Decision,
} from "@task-authority/approval-ui";
import "@task-authority/approval-ui/styles.css";
import "./review.css";

type Config = {
  auth0Domain: string;
  reviewerClientId: string;
  authorityUrl: string;
  authorityAudience: string;
  reviewerParEnabled?: string;
};
type AppState = {
  approval?: string;
  org?: string;
  decision?: Decision;
  digest?: string;
};

const SCOPE = "openid profile approvals:read approvals:decide";
const MFA = "http://schemas.openid.net/pape/policies/2007/06/multi-factor";
const base = `${location.origin}${location.pathname}`;
const params = new URLSearchParams(location.search);
const pageUrl = (approval?: string, org?: string) =>
  approval
    ? `${base}?approval=${encodeURIComponent(approval)}&org=${encodeURIComponent(org ?? "")}`
    : base;

/**
 * Same-page navigation without a reload. Tokens live only in memory (nothing persisted in the
 * browser), so a full page load would mean signing in again.
 */
function useRoute() {
  const [search, setSearch] = useState(location.search);
  useEffect(() => {
    const sync = () => setSearch(location.search);
    const click = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (
        !a ||
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        a.target
      )
        return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname)
        return;
      e.preventDefault();
      history.pushState({}, "", url);
      sync();
      scrollTo(0, 0);
    };
    addEventListener("popstate", sync);
    document.addEventListener("click", click);
    return () => {
      removeEventListener("popstate", sync);
      document.removeEventListener("click", click);
    };
  }, []);
  return useMemo(() => new URLSearchParams(search), [search]);
}

function Shell(props: { children: ReactNode; user?: ReactNode }) {
  return (
    <div className="page">
      <nav className="topbar">
        <a className="brand" href={base}>
          <span className="logo" aria-hidden="true">
            <Check size={13} strokeWidth={3} />
          </span>
          <span>Task Authority</span>
          <span className="slash">/</span>
          <span className="crumb">Approvals</span>
        </a>
        <span className="tag">Reference implementation</span>
        <span className="spacer" />
        {props.user}
      </nav>
      <main className="content">{props.children}</main>
    </div>
  );
}

/** Confirms a PAR/RAR batch completed by the confidential reviewer backend. */
function TransactionConfirmation() {
  const [views, setViews] = useState<ApprovalView[] | null>(null);
  const [status, setStatus] = useState("Loading the confirmed operations…");
  useEffect(() => {
    void fetch("/api/reviewer/transaction")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error);
        setViews(body.approvals);
        setStatus(
          `Review each of the ${body.approvals.length} operations before confirming.`,
        );
      })
      .catch((e) => setStatus(e instanceof Error ? e.message : "Unavailable"));
  }, []);
  const decide = async (decision: Decision) => {
    const r = await fetch("/api/reviewer/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const value = await r.json();
    setStatus(
      r.ok
        ? "Decisions recorded."
        : `Decision refused: ${value.code ?? value.error}`,
    );
    if (r.ok) setViews([]);
  };
  return (
    <Card className="ta-queue">
      <header className="ta-queue-head">
        <div>
          <h2>Confirm selected approvals</h2>
          <p id="status" role="status" className="ta-muted">
            {status}
          </p>
        </div>
      </header>
      <ul className="ta-rows">
        {(views ?? []).map((v) => (
          <li className="ta-row" key={v.id}>
            <span className="ta-row-link">
              <span className="ta-row-main">
                <span className="ta-row-title">{v.operation?.action}</span>
                <span className="ta-row-sub">
                  {v.operation?.resource} ·{" "}
                  {JSON.stringify(v.operation?.arguments)}
                </span>
              </span>
            </span>
          </li>
        ))}
      </ul>
      {views?.length ? (
        <footer className="ta-actions">
          {(["reject", "approve"] as const).map((d) => (
            <Button
              key={d}
              variant={d === "approve" ? "primary" : "secondary"}
              onClick={() => decide(d)}
            >
              {`Confirm ${d} for ${views.length} item(s)`}
            </Button>
          ))}
        </footer>
      ) : null}
    </Card>
  );
}

function Reviewer(props: { cfg: Config; resumed: AppState | null }) {
  const { cfg } = props;
  const auth = useAuth0();
  const route = useRoute();
  const approvalId = route.get("approval") ?? "";
  const org = route.get("org") ?? "";
  const client = useMemo(() => {
    // dpopNonceId is what makes fetchWithAuth attach the DPoP proof.
    const fetcher = auth.createFetcher({ dpopNonceId: "task-authority" });
    return approvalClient(cfg.authorityUrl, (url, init) =>
      fetcher.fetchWithAuth(url, init, { audience: cfg.authorityAudience }),
    );
  }, [auth.createFetcher, cfg]);

  const login = (extra: Record<string, string> = {}, appState: AppState = {}) =>
    auth.loginWithRedirect({
      appState: { approval: approvalId, org, ...appState },
      authorizationParams: {
        audience: cfg.authorityAudience,
        redirect_uri: base,
        scope: SCOPE,
        ...(org ? { organization: org } : {}),
        acr_values: MFA,
        max_age: 3600,
        ...extra,
      },
    });
  const par = async (ids: string[]) => {
    const r = await fetch("/api/reviewer/par", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalIds: ids }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error ?? body.code);
    location.assign(body.authorizationUrl);
  };
  const parEnabled = cfg.reviewerParEnabled === "true";

  const user = auth.isAuthenticated ? (
    <span className="user">
      <span className="avatar" aria-hidden="true">
        {(auth.user?.name ?? auth.user?.sub ?? "?").slice(0, 1).toUpperCase()}
      </span>
      <span className="user-name">{auth.user?.name ?? auth.user?.sub}</span>
      <button
        type="button"
        className="ta-icon-btn"
        aria-label="Sign out"
        onClick={() =>
          auth.logout({ logoutParams: { returnTo: pageUrl(approvalId, org) } })
        }
      >
        <LogOut size={14} />
      </button>
    </span>
  ) : null;

  if (auth.isLoading)
    return (
      <Shell>
        <p id="status" className="ta-muted center">
          Loading…
        </p>
      </Shell>
    );
  if (!auth.isAuthenticated)
    return (
      <Shell>
        <Card className="signin">
          <div className="signin-icon">
            <ShieldCheck size={20} />
          </div>
          <h1>Review an approval</h1>
          <p id="status" role="status" className="ta-muted">
            {auth.error
              ? auth.error.message
              : "Sign in with multi-factor authentication to see the exact operation waiting for you."}
          </p>
          <Button variant="primary" onClick={() => login()}>
            Sign in
          </Button>
        </Card>
      </Shell>
    );

  return (
    <Shell user={user}>
      {approvalId ? (
        <>
          <a className="back" href={base}>
            ← All approvals
          </a>
          <OperationApproval
            key={approvalId}
            approvalId={approvalId}
            client={client}
            resumed={
              props.resumed?.decision && props.resumed.digest
                ? {
                    decision: props.resumed.decision,
                    digest: props.resumed.digest,
                  }
                : null
            }
            backHref={base}
            stepUp={async (view, decision) => {
              if (parEnabled && view.viewerRole !== "owner")
                return par([view.id]);
              const { challenge } = await client.challenge(view.id);
              await login(
                {
                  max_age: "0",
                  prompt: "login",
                  task_authority_challenge: challenge,
                },
                {
                  approval: view.id,
                  org: view.operation?.organizationId,
                  decision,
                  digest: view.operationDigest,
                },
              );
            }}
          />
        </>
      ) : (
        <ApprovalQueue
          client={client}
          href={(v) => pageUrl(v.id, v.operation?.organizationId)}
          batch={
            parEnabled
              ? {
                  max: 5,
                  confirm: async (views) => {
                    for (const v of views) await client.lease(v.id);
                    await par(views.map((v) => v.id));
                  },
                }
              : undefined
          }
        />
      )}
    </Shell>
  );
}

const cfg = (await (await fetch("/api/config")).json()) as Config;
const root = createRoot(document.getElementById("root")!);
if (params.has("transaction"))
  root.render(
    <Shell>
      <TransactionConfirmation />
    </Shell>,
  );
else if (!cfg.auth0Domain || !cfg.reviewerClientId)
  root.render(
    <Shell>
      <p id="status" className="ta-muted center">
        Reviewer sign-in is not configured.
      </p>
    </Shell>,
  );
else {
  let resumed: AppState | null = null;
  const render = () =>
    root.render(
      <Auth0Provider
        domain={cfg.auth0Domain}
        clientId={cfg.reviewerClientId}
        useDpop
        cacheLocation="memory"
        authorizationParams={{
          audience: cfg.authorityAudience,
          redirect_uri: base,
          scope: SCOPE,
        }}
        onRedirectCallback={(appState) => {
          const state = appState as AppState | undefined;
          resumed = state ?? null;
          history.replaceState({}, "", pageUrl(state?.approval, state?.org));
          dispatchEvent(new PopStateEvent("popstate"));
          render();
        }}
      >
        <Reviewer cfg={cfg} resumed={resumed} />
      </Auth0Provider>,
    );
  render();
}
