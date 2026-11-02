// approve(): a verified human decision as a step of any durable workflow, proven by
// a token Auth0 signs. Engine adapters live next to this file (./cloudflare.js);
// everything they do is built from these functions, so other engines can follow.
export {
  approvalConfig,
  createApprovalRequest,
  approvalLink,
  readApprovalLink,
  verifyApproval,
  requireApproval,
  approvalKey,
  approvalBinding,
  actionDigest,
  canonicalize,
  durationMs,
  startPush,
  pollPush,
  auth0RolesRecheck,
  bindingMessage,
  ApprovalError,
  ApprovalRejected,
  ApprovalExpired,
  AUTHORIZATION_DETAILS_TYPE,
  DEFAULT_NAMESPACE,
  type Approval,
  type ApprovalConfig,
  type ApprovalInput,
  type ApprovalRequest,
  type ApprovalStore,
  type Approvers,
  type Channel,
  type Decision,
  type Json,
  type PushPoll,
  type PushStart,
} from "./core.js";
export {
  handleApprovalRoute,
  type ApprovalRoutesOptions,
  type Delivery,
} from "./routes.js";
export { verifyAgentsApproval, type AgentsApprovalMetadata } from "./agents.js";
export {
  approveInngest,
  inngestApprovalRoutes,
  type InngestApproveOptions,
  type InngestClientLike,
  type InngestStepLike,
} from "./inngest.js";
export {
  approveTemporal,
  createTemporalApprovalActivities,
  temporalApprovalRoutes,
  TEMPORAL_APPROVAL_SIGNAL,
  type TemporalApprovalActivities,
  type TemporalClientLike,
  type TemporalDecisionSignal,
  type TemporalSignalDefinitionLike,
  type TemporalWorkflowRuntimeLike,
} from "./temporal.js";
export {
  approveVercel,
  vercelApprovalRoutes,
  type VercelApproveOptions,
  type VercelHook,
  type VercelWorkflowApi,
} from "./vercel.js";
export {
  createPostgresApprovalLedger,
  type ApprovalLedger,
  type ApprovalLedgerDb,
} from "./ledger.js";
