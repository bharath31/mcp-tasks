// The approval page and its Auth0 round trip, as one Fetch API handler. It runs
// unchanged on Workers, Next.js route handlers, Hono, Deno and Node 22.
//
//   GET  {base}?r=…        the request, rendered from the signed link
//   POST {base}            Approve or Reject: redirect to Auth0 (passkey, prompt=login)
//   GET  {base}/callback   exchange the code, check the proof, hand it to the engine
import {
  ApprovalError,
  authorizeUrl,
  basePathOf,
  exchangeCode,
  issuerOf,
  openState,
  pkce,
  readApprovalLink,
  sealState,
  verifyApproval,
  type Approval,
  type ApprovalConfig,
  type ApprovalRequest,
  type ApprovalStore,
  type Decision,
  type Json,
} from "./core.js";

export type Delivery = {
  request: ApprovalRequest;
  decision: Decision;
  /** The Auth0-signed proof. The workflow verifies it again after it resumes. */
  proof: string;
  /** This handler's own check, for logging; never a substitute for the workflow's. */
  approval: Approval;
};

export type ApprovalRoutesOptions = {
  /** Resume the waiting workflow with the proof (e.g. instance.sendEvent). */
  deliver: (d: Delivery) => Promise<void>;
  /** Product name in the page header. */
  appName?: string;
  now?: () => number;
  /** Optional durable storage for requests whose signed links exceed 6 KB. */
  store?: ApprovalStore;
  /** Deliver the `approval` event shape consumed by AgentWorkflow.waitForApproval. */
  agentsSdk?: boolean;
};

/** Returns a Response for approval routes, or null so your router can continue. */
export async function handleApprovalRoute(
  req: Request,
  cfg: ApprovalConfig,
  opts: ApprovalRoutesOptions,
): Promise<Response | null> {
  const url = new URL(req.url);
  const base = basePathOf(cfg);
  const now = opts.now?.() ?? Date.now();
  const page = (status: number, body: string) =>
    html(status, cfg, opts.appName, body);
  try {
    if (url.pathname === base && req.method === "GET") {
      const token = url.searchParams.get("r") ?? "";
      const r = await readApprovalLink(cfg, token, now, opts.store);
      return page(200, requestPage(r, token, base, now));
    }
    if (url.pathname === base && req.method === "POST") {
      const form = await req.formData();
      const token = String(form.get("r") ?? "");
      const d = form.get("decision");
      if (d !== "approve" && d !== "reject")
        throw new ApprovalError("invalid_request", "Choose Approve or Reject.");
      const r = await readApprovalLink(cfg, token, now, opts.store);
      const { verifier, challenge } = await pkce();
      const state = await sealState(cfg, { r: token, d, cv: verifier });
      return new Response(null, {
        status: 303,
        headers: {
          location: await authorizeUrl(cfg, r, d, state, challenge),
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }
    if (url.pathname === `${base}/callback` && req.method === "GET") {
      const q = url.searchParams;
      if (q.get("error"))
        throw new ApprovalError(
          "provider_error",
          q.get("error_description") || "Sign-in was cancelled.",
        );
      const s = await openState(cfg, q.get("state") ?? "");
      const r = await readApprovalLink(cfg, s.r, now, opts.store);
      const proof = await exchangeCode(cfg, q.get("code") ?? "", s.cv);
      const approval = await verifyApproval(cfg, r, proof, now);
      if (approval.decision !== s.d)
        throw new ApprovalError(
          "wrong_request",
          "The decision does not match the sign-in.",
        );
      await opts.deliver({
        request: r,
        decision: approval.decision,
        proof,
        approval,
      });
      return page(200, donePage(r, approval));
    }
    return null;
  } catch (e) {
    if (!(e instanceof ApprovalError)) throw e;
    const status =
      e.code === "provider_error"
        ? 502
        : e.code === "invalid_request"
          ? 400
          : 403;
    return page(status, errorPage(e));
  }
}

// ---------------------------------------------------------------------------
// Pages. Light, quiet, one column; the same tokens as the hosted approval page.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function value(v: Json): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function approverText(r: ApprovalRequest) {
  const parts = [
    ...(r.approvers.owner ? ["the agent's owner"] : []),
    ...(r.approvers.users ?? []).map((u) => r.approverLabels?.[u] ?? u),
    ...(r.approvers.roles ?? []).map((x) => `anyone with the ${x} role`),
  ];
  return parts.join(", or ");
}

function remaining(r: ApprovalRequest, now: number) {
  const s = r.exp - Math.floor(now / 1000);
  if (s < 90) return `${Math.max(0, s)} seconds`;
  if (s < 5400) return `${Math.round(s / 60)} minutes`;
  return `${Math.round(s / 3600)} hours`;
}

function requestPage(
  r: ApprovalRequest,
  token: string,
  base: string,
  now: number,
) {
  if (r.exp <= Math.floor(now / 1000))
    return `<p class="eyebrow no">Expired</p><h1>This request has expired</h1><p class=lede>The approval window closed. No decision was recorded.</p>`;
  const rows = Object.entries(r.args)
    .map(([k, v]) => {
      const money =
        k === "amountMinor" &&
        typeof v === "number" &&
        Number.isSafeInteger(v) &&
        typeof r.args.currency === "string" &&
        /^[A-Z]{3}$/.test(r.args.currency);
      const formatted = money
        ? new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: r.args.currency as string,
          }).format((v as number) / 100)
        : undefined;
      return `<div class=row><dt>${esc(k)}</dt><dd>${formatted ? `<span>${esc(formatted)}</span> ` : ""}<code>${esc(value(v))}</code></dd></div>`;
    })
    .join("");
  return `
  <p class=eyebrow>Approval requested</p>
  <h1>${esc(r.summary ?? r.action)}</h1>
  <p class=lede>${r.requester ? `<b>${esc(r.requester)}</b> wants to run` : "An agent wants to run"} <code>${esc(r.action)}</code> on <code>${esc(r.resource)}</code>.</p>
  <dl class=card>${rows}
    <div class=row><dt>Resource</dt><dd><code>${esc(r.resource)}</code></dd></div>
    <div class=row><dt>Digest</dt><dd><code class=dim>${esc(r.digest.slice(0, 23))}…</code></dd></div>
  </dl>
  <form id=approval-form method=post action="${esc(base)}">
    <input type=hidden name=r value="${esc(token)}">
    <div class=actions>
      <button class=primary name=decision value=approve>Approve with passkey</button>
      <button class=secondary name=decision value=reject>Reject</button>
    </div>
  </form>
  <p class=meta>Who can decide: ${esc(approverText(r))}. Expires in <span id=countdown data-exp="${r.exp}">${esc(remaining(r, now))}</span>. Your decision is signed by your sign-in and applies to exactly these values.</p>
  <script>const c=document.getElementById('countdown'),f=document.getElementById('approval-form');function tick(){const s=Number(c.dataset.exp)-Math.floor(Date.now()/1000);if(s<=0){c.textContent='expired';f.remove();return}c.textContent=s<90?s+' seconds':s<5400?Math.ceil(s/60)+' minutes':Math.ceil(s/3600)+' hours'}tick();setInterval(tick,1000)</script>`;
}

function donePage(r: ApprovalRequest, a: Approval) {
  const who = esc(a.approver.name ?? a.approver.email ?? a.approver.sub);
  return a.decision === "approve"
    ? `<p class="eyebrow ok">Approved</p><h1>Done. The agent continues now.</h1>
       <p class=lede>${who} approved <code>${esc(r.action)}</code> on <code>${esc(r.resource)}</code> with a passkey.</p>
       <p class=meta>You can close this tab.</p>`
    : `<p class="eyebrow no">Rejected</p><h1>The agent won't do this.</h1>
       <p class=lede>${who} rejected <code>${esc(r.action)}</code> on <code>${esc(r.resource)}</code>.</p>
       <p class=meta>You can close this tab.</p>`;
}

function errorPage(e: ApprovalError) {
  const title =
    e.code === "expired"
      ? "This request has expired"
      : e.code === "not_an_approver" || e.code === "self_approval"
        ? "You can't decide this request"
        : e.code === "no_passkey"
          ? "A passkey is required"
          : "This approval didn't go through";
  return `<p class="eyebrow no">Not recorded</p><h1>${esc(title)}</h1><p class=lede>${esc(e.message)}</p>
  <p class=meta>Nothing was approved. The agent is still waiting, or has stopped if the request expired.</p>`;
}

function html(
  status: number,
  cfg: ApprovalConfig,
  appName: string | undefined,
  body: string,
) {
  const auth0 = new URL(issuerOf(cfg)).origin;
  return new Response(
    `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(appName ?? "Approval")}</title>
<style>
:root{--bg:#fafafa;--fg:#0a0a0a;--muted:#666;--line:#eaeaea;--card:#fff;--ok:#0a7d38;--no:#c4161c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,Geist,sans-serif;-webkit-font-smoothing:antialiased}
header{border-bottom:1px solid var(--line);background:#fff}header div{max-width:560px;margin:0 auto;padding:14px 16px;font-weight:600;letter-spacing:-.01em}
main{max-width:560px;margin:0 auto;padding:40px 16px 64px}
.eyebrow{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.ok{color:var(--ok)}.no{color:var(--no)}
h1{margin:0 0 10px;font-size:26px;line-height:1.2;letter-spacing:-.025em;font-weight:650}
.lede{margin:0 0 24px;color:#333}code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2f2f2;border-radius:5px;padding:1px 5px}code.dim{color:var(--muted)}
.card{margin:0 0 24px;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.row{display:flex;gap:16px;justify-content:space-between;padding:12px 16px;border-top:1px solid var(--line)}.row:first-child{border-top:0}
dt{color:var(--muted)}dd{margin:0;text-align:right;word-break:break-all}
.actions{display:flex;gap:10px;flex-wrap:wrap}
button{font:inherit;font-weight:550;border-radius:8px;padding:10px 16px;cursor:pointer;border:1px solid var(--fg)}
.primary{background:var(--fg);color:#fff}.primary:hover{background:#333}.secondary{background:#fff;color:var(--fg);border-color:var(--line)}.secondary:hover{border-color:#999}
.meta{margin:20px 0 0;font-size:13px;color:var(--muted)}
</style>
<header><div>${esc(appName ?? "Approval")}</div></header><main>${body}</main></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self' ${auth0}; frame-ancestors 'none'; base-uri 'none'`,
      },
    },
  );
}
