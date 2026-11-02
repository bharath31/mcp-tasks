// Optional, thin MCP Tasks helpers. Nothing here depends on MCP wire details
// and the service never imports it.
import {
  verifiedAgent,
  verifiedSubject,
  type OperationView,
  type VerifiedAgent,
  type VerifiedSubject,
} from "./types.js";

/** Subset of an MCP SDK `AuthInfo` produced by the MCP auth adapter at the entry point. */
export type McpAuthInfo = { token: string; clientId: string };

/**
 * Maps authenticated MCP entry context to typed identities. The organization
 * and agent must come from the verified token/registration, not tool arguments.
 */
export function principalFromMcpAuth(
  auth: McpAuthInfo,
  verified: { organizationId: string; agentId: string },
): { owner: VerifiedSubject; agent: VerifiedAgent } {
  return {
    owner: verifiedSubject({
      accessToken: auth.token,
      organizationId: verified.organizationId,
    }),
    agent: verifiedAgent(verified.agentId),
  };
}

/** Stable logical key: a new MCP task id must never mint a second authorization. */
export const operationKey = (...parts: Array<string | number>) =>
  parts.map((p) => String(p).replace(/[^A-Za-z0-9_.\-]/g, "-")).join(":");

/** Honest, non-leaky status text for polling `tasks/get` from authority state. */
export function describeAuthority(
  op: Pick<
    OperationView,
    "status" | "approvalRequirement" | "approvalStatus" | "claim"
  >,
) {
  if (op.status === "cancelled")
    return {
      state: "cancelled",
      message: "Authority was withdrawn before dispatch.",
    };
  if (op.status === "rejected")
    return {
      state: "rejected",
      message: "A reviewer rejected this operation.",
    };
  if (op.status === "settled")
    return {
      state: "settled",
      message: "The application reported a provider outcome.",
    };
  if (op.status === "claimed")
    return {
      state: "dispatch_authorized",
      message:
        "Dispatch was authorized; the provider outcome is being reconciled.",
    };
  if (op.approvalRequirement === "human") {
    if (op.approvalStatus === "pending")
      return {
        state: "awaiting_human_approval",
        message: "Waiting for an eligible reviewer.",
      };
    if (op.approvalStatus === "expired" || op.approvalStatus === null)
      return {
        state: "approval_needed",
        message: "A fresh reviewer decision is required.",
      };
  }
  return {
    state: "ready",
    message: "Ready for a final authorization check before dispatch.",
  };
}
