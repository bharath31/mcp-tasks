// Cloudflare Agents SDK's AgentWorkflow adapter. The Agents SDK owns the wait;
// callers verify the metadata returned by waitForApproval with this helper.
import {
  ApprovalError,
  verifyApproval,
  type Approval,
  type ApprovalConfig,
  type ApprovalRequest,
} from "./core.js";

/** Metadata returned by AgentWorkflow.waitForApproval(). */
export type AgentsApprovalMetadata = { proof: string };

/** Verify the Auth0 proof carried by an Agents SDK approval event. */
export async function verifyAgentsApproval(
  cfg: ApprovalConfig,
  request: ApprovalRequest,
  metadata: unknown,
): Promise<Approval> {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    typeof (metadata as Record<string, unknown>).proof !== "string"
  )
    throw new ApprovalError("invalid_proof", "The approval carried no proof.");
  return verifyApproval(
    cfg,
    request,
    (metadata as AgentsApprovalMetadata).proof,
  );
}
