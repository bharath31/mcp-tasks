import { createHash, randomBytes } from "node:crypto";
import type { ApprovalView, TaskAuthority } from "@task-authority/sdk";

type Transaction = {
  verifier: string;
  expires: number;
  ids: string[];
  token?: string;
  views?: ApprovalView[];
  used?: boolean;
};
/** Reference confidential reviewer backend. Restart discards in-flight logins; no tokens reach browser JS. */
export class ReviewerBackend {
  private transactions = new Map<string, Transaction>();
  constructor(
    private options: {
      domain: string;
      clientId: string;
      clientSecret: string;
      audience: string;
      publicUrl: string;
      authority: TaskAuthority;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {}
  private get now() {
    return this.options.now ?? Date.now;
  }
  private json(
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      },
    });
  }
  private cookie(state: string) {
    return `ta_review=${state}; HttpOnly; SameSite=Lax; Path=/api/reviewer; Max-Age=300${new URL(this.options.publicUrl).protocol === "https:" ? "; Secure" : ""}`;
  }
  private async oauth(path: string, body: Record<string, string>) {
    const response = await (this.options.fetch ?? fetch)(
      `https://${this.options.domain}/${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          ...body,
        }),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("reviewer_authorization_unavailable");
    return (await response.json()) as Record<string, any>;
  }
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const origin = new URL(this.options.publicUrl).origin;
    for (const [key, tx] of this.transactions)
      if (tx.expires <= this.now()) this.transactions.delete(key);
    if (req.method === "POST" && req.headers.get("origin") !== origin)
      return this.json({ error: "origin_required" }, 403);
    const state =
      req.headers
        .get("cookie")
        ?.match(/(?:^|;\s*)ta_review=([A-Za-z0-9_-]+)/)?.[1] ?? "";
    const tx = this.transactions.get(state);
    const redirectUri = `${origin}/api/reviewer/callback`;
    if (url.pathname === "/api/reviewer/par" && req.method === "POST") {
      if (this.transactions.size >= 1000)
        return this.json({ error: "reviewer_capacity" }, 429);
      const body = (await req.json().catch(() => null)) as {
        approvalIds?: unknown;
      } | null;
      const ids = body?.approvalIds;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 5 ||
        ids.some((id) => typeof id !== "string" || id.length > 200) ||
        new Set(ids).size !== ids.length
      )
        return this.json({ error: "invalid_approval_set" }, 400);
      const views = await Promise.all(
        ids.map((id) => this.options.authority.approvals.get(id)),
      );
      if (
        views.some(
          (view) =>
            view.status !== "pending" ||
            view.operation?.action !== views[0]!.operation?.action ||
            view.operation?.organizationId !==
              views[0]!.operation?.organizationId,
        )
      )
        return this.json({ error: "incompatible_approval_set" }, 400);
      const nonce = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const details = views.map((view) => ({
        type: "task_authority_approval",
        approval_id: view.id,
        operation_digest: view.operationDigest,
      }));
      const params: Record<string, string> = {
        response_type: "code",
        redirect_uri: redirectUri,
        scope: "openid profile",
        audience: this.options.audience,
        state: nonce,
        nonce,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        max_age: "0",
        acr_values:
          "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
        authorization_details: JSON.stringify(details),
        organization: views[0]!.operation!.organizationId,
      };
      const pushed = await this.oauth("oauth/par", params);
      if (typeof pushed.request_uri !== "string")
        throw new Error("reviewer_par_failed");
      this.transactions.set(nonce, {
        verifier,
        expires: this.now() + 300000,
        ids,
      });
      const authorize = new URL(`https://${this.options.domain}/authorize`);
      authorize.searchParams.set("client_id", this.options.clientId);
      authorize.searchParams.set("request_uri", pushed.request_uri);
      return this.json({ authorizationUrl: authorize.href }, 200, {
        "set-cookie": this.cookie(nonce),
      });
    }
    if (!tx || tx.used)
      return this.json({ error: "reviewer_transaction_required" }, 401);
    if (url.pathname === "/api/reviewer/callback" && req.method === "GET") {
      if (
        url.searchParams.get("state") !== state ||
        !url.searchParams.get("code") ||
        tx.token
      )
        return this.json({ error: "invalid_oauth_state" }, 400);
      const result = await this.oauth("oauth/token", {
        grant_type: "authorization_code",
        code: url.searchParams.get("code")!,
        code_verifier: tx.verifier,
        redirect_uri: redirectUri,
      });
      if (typeof result.access_token !== "string")
        throw new Error("reviewer_token_missing");
      // The service verifies the token, eligibility, organization and exact reviewer identity.
      const views = await Promise.all(
        tx.ids.map((id) =>
          this.options.authority.approvals.get(id, {
            accessToken: result.access_token,
          }),
        ),
      );
      tx.token = result.access_token;
      tx.views = views;
      return new Response(null, {
        status: 303,
        headers: {
          location: `${origin}/review.html?transaction=ready`,
          "cache-control": "no-store",
        },
      });
    }
    if (!tx.token || !tx.views)
      return this.json({ error: "reviewer_login_incomplete" }, 401);
    if (url.pathname === "/api/reviewer/transaction" && req.method === "GET")
      return this.json({ approvals: tx.views });
    if (url.pathname === "/api/reviewer/decision" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        decision?: string;
      } | null;
      if (body?.decision !== "approve" && body?.decision !== "reject")
        return this.json({ error: "invalid_decision" }, 400);
      const result = await this.options.authority.approvals.decideBatch({
        accessToken: tx.token,
        decisions: tx.views.map((view) => ({
          approvalId: view.id,
          decision: body.decision as "approve" | "reject",
          operationDigest: view.operationDigest,
        })),
      });
      tx.used = true;
      tx.token = undefined;
      return this.json(result, 200, { "set-cookie": this.cookie("") });
    }
    return this.json({ error: "not_found" }, 404);
  }
}
