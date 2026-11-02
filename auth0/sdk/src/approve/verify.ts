// Small verification-only entrypoint for the Task Authority service bridge.
// Keeping this separate from the SDK barrel avoids loading routes or adapters.
export {
  actionDigest,
  approvalConfig,
  verifyApproval,
  type Approval,
  type ApprovalConfig,
  type ApprovalRequest,
} from "./core.js";
