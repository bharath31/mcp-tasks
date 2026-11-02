import type { CibaConfig } from "./ciba.js";
import type { Fga } from "./fga.js";

/** Per-action policy: which FGA relations gate requesting and approving. */
export type ActionPolicy = {
  /** Relation on organization:<id> the initiating/owning user must hold. */
  requesterRelation: string;
  /** Relation on organization:<id> an approver must hold. */
  approverRelation: string;
  /**
   * Tenant-administrator guard (defense in depth): arguments above these values
   * always require a human, whatever the customer's own policy asserts.
   */
  autoApproveCeilings?: Record<string, number>;
  policyVersion: string;
  /**
   * Resource servers (policy keys) a human-direct registration of this action may
   * target. Human callers choose `resourceServer`, so the operator names the
   * policies that may govern the action; none listed means none permitted.
   */
  resourceServers?: string[];
};

export type TenantConfig = {
  tenantId: string;
  issuer: string;
  audience: string;
  /** Verifies tokens for this issuer: remote JWKS in production, local set in tests. */
  keys: Parameters<typeof import("jose").jwtVerify>[1];
  fga: Fga;
  /** Namespace for custom claims Auth0 will not let an Action set under a reserved name (amr, auth_time). */
  claimNamespace?: string;
  /** Optional Web App audience for signed approve() link proofs. */
  approvalClientId?: string;
  /** Optional fetch transport, primarily for local OIDC integration tests. */
  approvalFetch?: typeof fetch;
  /** Optional CIBA approval channel (Auth0 backchannel authentication). */
  ciba?: CibaConfig;
  actions: Record<string, ActionPolicy>;
  defaults: {
    delegationMaxTtlSec: number;
    operationTtlSec: number;
    approvalTtlSec: number;
    claimLeaseSec: number;
    decisionMaxAgeSec: number;
  };
  quotas: {
    openDelegations: number;
    openApprovals: number;
    claimsPerDay: number;
    requestsPerMinute: number;
  };
};

export const DEMO_DEFAULTS: TenantConfig["defaults"] = {
  delegationMaxTtlSec: 48 * 3600,
  operationTtlSec: 48 * 3600,
  approvalTtlSec: 30 * 60,
  claimLeaseSec: 60,
  decisionMaxAgeSec: 5 * 60,
};
export const DEMO_QUOTAS: TenantConfig["quotas"] = {
  openDelegations: 500,
  openApprovals: 500,
  claimsPerDay: 10_000,
  requestsPerMinute: 600,
};

export type ServiceConfig = {
  tenants: TenantConfig[];
  allowedOrigins: string[];
  /** Maximum lifetime of verified user tokens accepted as grantor/approver proof. */
  clockSkewSec: number;
};
