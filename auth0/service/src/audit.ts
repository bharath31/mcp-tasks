import type { AuditEntry, EventType } from "@task-authority/contracts";
import type { Db } from "./store.js";
import { iso } from "./store.js";

export type AuditInput = {
  type: EventType;
  tenantId: string;
  organizationId: string;
  correlationId: string;
  delegationId?: string | null;
  operationId?: string | null;
  approvalId?: string | null;
  claimId?: string | null;
  actor: { kind: "user" | "service" | "system"; id: string };
  decision: "allow" | "deny" | "info";
  reasonCode?: string | null;
  /** Reason codes and identifiers only. Never tokens, assertions or payloads. */
  evaluation?: Record<string, unknown>;
  at: number;
};

const FORBIDDEN = /token|secret|password|authorization|assertion|email/i;

export async function audit(db: Db, e: AuditInput) {
  const evaluation = e.evaluation ?? {};
  for (const k of Object.keys(evaluation))
    if (FORBIDDEN.test(k)) throw new Error(`audit field not permitted: ${k}`);
  await db.query(
    `insert into authority.audit_events
     (tenant_id, organization_id, delegation_id, operation_id, approval_id, claim_id,
      correlation_id, type, actor_kind, actor_id, decision, reason_code, evaluation, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      e.tenantId,
      e.organizationId,
      e.delegationId ?? null,
      e.operationId ?? null,
      e.approvalId ?? null,
      e.claimId ?? null,
      e.correlationId,
      e.type,
      e.actor.kind,
      e.actor.id,
      e.decision,
      e.reasonCode ?? null,
      JSON.stringify(evaluation),
      iso(e.at),
    ],
  );
}

export function auditView(r: any): AuditEntry {
  return {
    id: String(r.id),
    type: r.type,
    at: iso(r.created_at),
    tenantId: r.tenant_id,
    organizationId: r.organization_id,
    delegationId: r.delegation_id,
    operationId: r.operation_id,
    approvalId: r.approval_id,
    claimId: r.claim_id,
    correlationId: r.correlation_id,
    actor: { kind: r.actor_kind, id: r.actor_id },
    decision: r.decision,
    reasonCode: r.reason_code,
    evaluation: r.evaluation,
  };
}
