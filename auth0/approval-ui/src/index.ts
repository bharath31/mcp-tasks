// Prototype approval page components for Task Authority. The page decides nothing itself:
// it renders Task Authority's record of one operation and posts the person's decision back.
export {
  approvalClient,
  ApprovalError,
  needsStepUp,
  type ApprovalClient,
  type ApprovalView,
  type AuthorizedFetch,
  type Decision,
} from "./api.js";
export {
  OperationApproval,
  defaultApprovalMessages,
  formatAmount,
  relative,
  type ApprovalMessages,
  type OperationApprovalProps,
} from "./OperationApproval.js";
export { ApprovalQueue, type ApprovalQueueProps } from "./ApprovalQueue.js";
export { Badge, Button, Card, CopyValue } from "./ui.js";
