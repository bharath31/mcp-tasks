-- Reviewer ownership is a short lease, independent of the durable decision.
alter table authority.approvals add column lease_reviewer_id text;
alter table authority.approvals add column lease_expires_at timestamptz;
create index approvals_queue on authority.approvals (tenant_id, organization_id, requested_at) where status='pending';
create index approvals_reviewer_velocity on authority.approvals (tenant_id, approver_id, decided_at) where decided_at is not null;
create table authority.used_dpop_proofs (
  tenant_id text not null,
  jkt text not null,
  jti text not null,
  expires_at timestamptz not null,
  primary key (tenant_id,jkt,jti)
);
alter table authority.used_dpop_proofs enable row level security;
create table authority.reviewer_sessions (
  tenant_id text not null,
  reviewer_id text not null,
  jkt text not null,
  auth_time bigint not null,
  last_seen_at timestamptz not null,
  primary key (tenant_id,reviewer_id,jkt,auth_time)
);
alter table authority.reviewer_sessions enable row level security;
create table authority.approval_challenges (
  challenge text primary key,
  tenant_id text not null,
  approval_id text not null references authority.approvals(id),
  operation_digest text not null,
  reviewer_id text not null,
  jkt text not null,
  requested_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
alter table authority.approval_challenges enable row level security;
create table authority.approval_decisions (
  approval_id text not null references authority.approvals(id),
  reviewer_id text not null,
  decision text not null check (decision in ('approve','reject')),
  assurance jsonb not null,
  decision_jti text,
  decided_at timestamptz not null,
  primary key (approval_id,reviewer_id)
);
alter table authority.approval_decisions enable row level security;
