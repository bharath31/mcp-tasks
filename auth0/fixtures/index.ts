// Data-only fixtures for the Northstar / Southridge scenarios. Users here are
// fixture identities, not real Auth0 accounts.
export type Tuple = { user: string; relation: string; object: string };

export const TENANT_ID = "tnt_demo";
export const ORG = {
  northstar: "org_northstar",
  southridge: "org_southridge",
} as const;
export const PEOPLE = {
  alice: "auth0|alice", // Northstar support employee (requester)
  morgan: "auth0|morgan", // Northstar refund manager (approver)
  olivia: "auth0|olivia", // Northstar admin (may issue org-owned grants)
  eve: "auth0|eve", // Northstar member without refund rights
  mallory: "auth0|mallory", // Southridge manager
  sam: "auth0|sam", // Southridge support employee (requester)
  dana: "auth0|dana", // Northstar developer (deploy requester)
  lee: "auth0|lee", // Northstar release lead (deploy approver)
  inspector: "auth0|inspector", // Northstar investigator
} as const;
export const AGENTS = {
  returns: "agent_returns",
  returnsSouthridge: "agent_returns_sr",
  deployBot: "agent_deploy",
} as const;
export const CLIENTS = {
  api: "client_refund_desk_api",
  executor: "client_refund_desk_executor",
  investigator: "client_security_console",
  rogue: "client_rogue",
} as const;

export const PERMISSIONS = {
  api: [
    "delegations:create",
    "delegations:read",
    "delegations:revoke",
    "operations:register",
    "operations:read",
    "operations:cancel",
    "approvals:request",
    "approvals:read",
  ],
  executor: ["operations:read", "claims:create", "outcomes:report"],
  investigator: [
    "usage:read",
    "audit:read",
    "operations:read",
    "delegations:read",
    "approvals:read",
  ],
} as const;

const u = (p: string) => `user:${p}`;
const o = (id: string) => `organization:${id}`;
export const BASE_TUPLES: Tuple[] = [
  { user: u(PEOPLE.alice), relation: "member", object: o(ORG.northstar) },
  {
    user: u(PEOPLE.alice),
    relation: "refund_request",
    object: o(ORG.northstar),
  },
  { user: u(PEOPLE.morgan), relation: "member", object: o(ORG.northstar) },
  {
    user: u(PEOPLE.morgan),
    relation: "refund_approve",
    object: o(ORG.northstar),
  },
  {
    user: u(PEOPLE.morgan),
    relation: "refund_request",
    object: o(ORG.northstar),
  },
  { user: u(PEOPLE.olivia), relation: "member", object: o(ORG.northstar) },
  { user: u(PEOPLE.olivia), relation: "admin", object: o(ORG.northstar) },
  { user: u(PEOPLE.eve), relation: "member", object: o(ORG.northstar) },
  { user: u(PEOPLE.dana), relation: "member", object: o(ORG.northstar) },
  {
    user: u(PEOPLE.dana),
    relation: "deploy_request",
    object: o(ORG.northstar),
  },
  { user: u(PEOPLE.lee), relation: "member", object: o(ORG.northstar) },
  { user: u(PEOPLE.lee), relation: "deploy_approve", object: o(ORG.northstar) },
  {
    user: u(PEOPLE.inspector),
    relation: "investigator",
    object: o(ORG.northstar),
  },
  { user: u(PEOPLE.mallory), relation: "member", object: o(ORG.southridge) },
  {
    user: u(PEOPLE.mallory),
    relation: "refund_approve",
    object: o(ORG.southridge),
  },
  { user: u(PEOPLE.sam), relation: "member", object: o(ORG.southridge) },
  {
    user: u(PEOPLE.sam),
    relation: "refund_request",
    object: o(ORG.southridge),
  },
  {
    user: `agent:${AGENTS.returnsSouthridge}`,
    relation: "registered_agent",
    object: o(ORG.southridge),
  },
  {
    user: `client:${CLIENTS.executor}`,
    relation: "trusted_backend",
    object: o(ORG.southridge),
  },
  {
    user: `agent:${AGENTS.returns}`,
    relation: "registered_agent",
    object: o(ORG.northstar),
  },
  {
    user: `agent:${AGENTS.deployBot}`,
    relation: "registered_agent",
    object: o(ORG.northstar),
  },
  {
    user: `client:${CLIENTS.api}`,
    relation: "trusted_backend",
    object: o(ORG.northstar),
  },
  {
    user: `client:${CLIENTS.executor}`,
    relation: "trusted_backend",
    object: o(ORG.northstar),
  },
  {
    user: `client:${CLIENTS.api}`,
    relation: "trusted_backend",
    object: o(ORG.southridge),
  },
];

/** Resource servers whose published policies may govern human-direct registrations. */
const RESOURCE_SERVERS = [
  `merchant:${ORG.northstar}/refunds`,
  `merchant:${ORG.southridge}/refunds`,
  `org:${ORG.northstar}/deploys`,
  "https://refund-desk.test/mcp",
];

/** Tenant action policy (service-side configuration). */
export const ACTION_POLICIES = {
  "refund:create": {
    requesterRelation: "refund_request",
    approverRelation: "refund_approve",
    autoApproveCeilings: { amountMinor: 10_000 },
    policyVersion: "refund-policy-2026-10",
    resourceServers: RESOURCE_SERVERS,
  },
  "deploy:production": {
    requesterRelation: "deploy_request",
    approverRelation: "deploy_approve",
    policyVersion: "deploy-policy-v1",
    resourceServers: RESOURCE_SERVERS,
  },
};
