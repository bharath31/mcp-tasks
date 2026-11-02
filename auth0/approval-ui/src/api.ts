import type { ApprovalView } from "@task-authority/contracts";

export type { ApprovalView };
export type Decision = "approve" | "reject";

/** Anything shaped like auth0-spa-js `Fetcher.fetchWithAuth` (DPoP proof and nonce handled by it). */
export type AuthorizedFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** A Task Authority refusal, with the service's stable code (e.g. `approver_ineligible`). */
export class ApprovalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** The approval endpoints the page needs; every call is made as the signed-in person. */
export function approvalClient(authorityUrl: string, fetch: AuthorizedFetch) {
  const path = (id: string) =>
    `/v1/approval-requests/${encodeURIComponent(id)}`;
  async function call<T>(p: string, body?: unknown): Promise<T> {
    const response = await fetch(
      `${authorityUrl}${p}`,
      body === undefined
        ? { method: "GET" }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const value = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new ApprovalError(
        value.code ?? String(response.status),
        `${value.code ?? response.status}: ${value.message ?? "Request refused"}`,
        value.details?.reason,
      );
    return value as T;
  }
  return {
    get: (id: string) => call<ApprovalView>(path(id)),
    pending: async () =>
      (
        await call<{ approvals: ApprovalView[] }>(
          "/v1/approval-requests?status=pending",
        )
      ).approvals,
    lease: (id: string) => call<unknown>(`${path(id)}/lease`, {}),
    challenge: (id: string) =>
      call<{ challenge: string }>(`${path(id)}/challenge`, {}),
    decide: (id: string, decision: Decision, operationDigest: string) =>
      call<{ status: string }>(`${path(id)}/decisions`, {
        decision,
        operationDigest,
      }),
  };
}
export type ApprovalClient = ReturnType<typeof approvalClient>;

/** Whether approving needs a fresh, operation-bound step-up (always true for an owner). */
export const needsStepUp = (view: ApprovalView) =>
  view.viewerRole === "owner" || view.assurance?.assurance !== "session_mfa";
