// A second, unrelated protected operation on the SAME Task Authority SDK and
// service contract: gate a production deployment on a release lead's approval.
// No service change was needed: only a tenant action policy ("deploy:production").
import {
  verifiedAgent,
  verifiedSubject,
  type TaskAuthority,
} from "@task-authority/sdk";

export type Deploy = { service: string; version: string; changeId: string };

/** Request: scope authority to this exact deploy; a human decision is always required. */
export async function requestDeploy(
  a: TaskAuthority,
  who: { subjectToken: string; orgId: string; agentId: string },
  d: Deploy,
) {
  const owner = verifiedSubject({
    accessToken: who.subjectToken,
    organizationId: who.orgId,
  });
  const delegation = await a.delegations.create({
    owner,
    agent: verifiedAgent(who.agentId),
    ownerType: "user",
    resource: `org:${who.orgId}/deploys`,
    actions: ["deploy:production"],
    expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
  });
  const op = await a.operations.register({
    delegationId: delegation.id,
    operationKey: `deploy:${d.service}:${d.version}`,
    action: "deploy:production",
    resource: `service:${d.service}`,
    arguments: { ...d, environment: "production" },
    approvalAssertion: "human",
    initiator: owner,
  });
  const approval = await a.approvals.request({
    operationId: op.id,
    permission: "deploy_approve",
  });
  return { op, approval };
}

/** Execute: only after an authorized claim; the deployer is the customer's own provider integration. */
export async function runDeploy(
  executor: TaskAuthority,
  op: { id: string; digest: string; operationKey: string },
  deployer: () => Promise<{ id: string }>,
) {
  const claim = await executor.operations.authorizeAndClaim({
    operationId: op.id,
    operationDigest: op.digest,
    executionKey: op.operationKey,
  });
  if (claim.decision !== "authorized") return claim;
  const run = await deployer();
  await executor.operations.reportOutcome({
    operationId: op.id,
    claimId: claim.claimId,
    providerStatus: "succeeded",
    providerReference: run.id,
  });
  return { ...claim, deployId: run.id };
}
