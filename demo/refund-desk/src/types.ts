import type { ClaimDenied, TaskAuthority } from "@task-authority/sdk";
import type { Payments, ProviderRefund } from "./payments.js";
import type { MerchantPolicy } from "./policy.js";

export type Deps = {
  authority: TaskAuthority;
  executor: TaskAuthority;
  payments: Payments;
  policy: MerchantPolicy;
  now(): number;
  /** Auth0 API identifier; all transports use this one policy namespace. */
  resourceServer?: string;
  /** Optional org-issued delegation per organization (org-owned authority); otherwise one user-owned grant per task. */
  standingDelegations?: Record<string, string>;
};
/** Verified at the MCP boundary; subjectToken is the user's token for the authority audience. */
export type Caller = {
  subjectToken: string;
  orgId: string;
  agentId: string;
  actorType?: "human" | "agent";
};
export type Dispatch =
  | { kind: "denied"; claim: ClaimDenied }
  | { kind: "outcome"; refund: ProviderRefund }
  | { kind: "released" };
/** Thrown when the provider call may have happened: the outcome must be reconciled, never assumed. */
export class DispatchUncertain extends Error {}
