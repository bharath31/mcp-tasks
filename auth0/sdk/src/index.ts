export {
  TaskAuthority,
  type TaskAuthorityOptions,
  type RetryPolicy,
} from "./client.js";
export { AuthorizationRequired, TaskAuthorityError } from "./errors.js";
export * from "./types.js";
export {
  protect,
  renderRest,
  renderCli,
  outcomeExitCode,
  renderMcp,
  stepUpChallenge,
  OWNER_APPROVAL_INPUT,
  ownerApprovalInputKey,
  type ProtectOptions,
  type ProtectedOutcome,
  type RenderMcpOptions,
} from "./protect.js";
export {
  CLAIM_DENIAL_CODES,
  ERROR_CODES,
  type ErrorCode,
} from "@task-authority/contracts";
export {
  createTaskAuthority,
  resolveConfig,
  type TaskAuthorityConfig,
  type TaskAuthorityApp,
  type ActionDefinition,
  type ActionContext,
  type ActionOutcome,
  type CallOptions,
  type ProtectedAction,
} from "./app.js";
