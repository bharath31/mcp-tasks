-- Task Authority service datastore (prototype). Owned exclusively by the
-- service. The customer application must never be granted access to this
-- schema (see README: roles and privileges).
create schema if not exists authority;
revoke all on schema authority from public;

create table authority.delegations (
  id text primary key,
  tenant_id text not null,
  organization_id text not null,
  owner_type text not null check (owner_type in ('user', 'organization')),
  actor_id text not null,
  agent_id text not null,
  resource text not null,
  actions text[] not null,
  resource_prefixes text[],
  ceilings jsonb not null default '{}',
  reason text,
  provenance jsonb not null,
  policy_ref text not null,
  correlation_id text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text,
  check (expires_at > created_at)
);
create index delegations_tenant_org on authority.delegations (tenant_id, organization_id);

-- Provenance and scope are immutable. Only the revocation columns may change,
-- and revocation can happen once.
create function authority.delegations_immutable() returns trigger language plpgsql as $$
begin
  if (new.id, new.tenant_id, new.organization_id, new.owner_type, new.actor_id,
      new.agent_id, new.resource, new.actions, new.resource_prefixes, new.ceilings,
      new.provenance, new.policy_ref, new.correlation_id, new.created_at, new.expires_at)
     is distinct from
     (old.id, old.tenant_id, old.organization_id, old.owner_type, old.actor_id,
      old.agent_id, old.resource, old.actions, old.resource_prefixes, old.ceilings,
      old.provenance, old.policy_ref, old.correlation_id, old.created_at, old.expires_at)
  then raise exception 'delegation scope and provenance are immutable'; end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at
  then raise exception 'delegation already revoked'; end if;
  return new;
end $$;
create trigger delegations_immutable before update on authority.delegations
  for each row execute function authority.delegations_immutable();

create table authority.operations (
  id text primary key,
  tenant_id text not null,
  organization_id text not null,
  delegation_id text not null references authority.delegations (id),
  operation_key text not null,
  task_id text,
  action text not null,
  resource text not null,
  scope text not null,
  arguments jsonb not null,
  canonical_version integer not null,
  canonical text not null,
  digest text not null,
  business_state_version text,
  approval_assertion text not null check (approval_assertion in ('none', 'human')),
  approval_requirement text not null check (approval_requirement in ('none', 'human')),
  initiator_id text,
  correlation_id text not null,
  status text not null check (status in ('registered', 'claimed', 'settled', 'cancelled', 'rejected')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  unique (tenant_id, organization_id, operation_key)
);
create index operations_delegation on authority.operations (delegation_id);
create index operations_task on authority.operations (tenant_id, task_id);

create function authority.operations_immutable() returns trigger language plpgsql as $$
begin
  if (new.id, new.tenant_id, new.organization_id, new.delegation_id, new.operation_key,
      new.action, new.resource, new.scope, new.arguments, new.canonical_version,
      new.canonical, new.digest, new.business_state_version, new.approval_requirement)
     is distinct from
     (old.id, old.tenant_id, old.organization_id, old.delegation_id, old.operation_key,
      old.action, old.resource, old.scope, old.arguments, old.canonical_version,
      old.canonical, old.digest, old.business_state_version, old.approval_requirement)
  then raise exception 'protected operation fields are immutable'; end if;
  return new;
end $$;
create trigger operations_immutable before update on authority.operations
  for each row execute function authority.operations_immutable();

create table authority.approvals (
  id text primary key,
  tenant_id text not null,
  organization_id text not null,
  operation_id text not null references authority.operations (id),
  operation_digest text not null,
  permission text not null,
  reviewer_hint text,
  status text not null check (status in ('pending', 'approved', 'rejected', 'expired')),
  approver_id text,
  assurance jsonb,
  method text not null check (method in ('portal_stepup', 'ciba_rar')),
  decision_jti text,
  correlation_id text not null,
  policy_source text not null,
  requested_at timestamptz not null,
  decided_at timestamptz,
  expires_at timestamptz not null
);
create index approvals_operation on authority.approvals (operation_id);
-- At most one live (pending or approved) approval per operation.
create unique index approvals_one_live on authority.approvals (operation_id)
  where status in ('pending', 'approved');

create table authority.claims (
  id text primary key,
  tenant_id text not null,
  organization_id text not null,
  operation_id text not null references authority.operations (id),
  delegation_id text not null references authority.delegations (id),
  approval_id text references authority.approvals (id),
  seq integer not null,
  status text not null check (status in ('claimed', 'pending', 'unknown', 'succeeded', 'failed', 'released')),
  execution_key text not null,
  claimed_by text not null,
  effective_authority jsonb not null,
  correlation_id text not null,
  minted_at timestamptz not null,
  lease_expires_at timestamptz not null,
  outcome jsonb,
  unique (operation_id, seq)
);
-- One logical authorization per operation: only a released claim may be replaced.
create unique index claims_one_live on authority.claims (operation_id)
  where status <> 'released';

create table authority.audit_events (
  id bigserial primary key,
  tenant_id text not null,
  organization_id text not null,
  delegation_id text,
  operation_id text,
  approval_id text,
  claim_id text,
  correlation_id text not null,
  type text not null,
  actor_kind text not null check (actor_kind in ('user', 'service', 'system')),
  actor_id text not null,
  decision text not null check (decision in ('allow', 'deny', 'info')),
  reason_code text,
  evaluation jsonb not null default '{}',
  created_at timestamptz not null
);
create index audit_operation on authority.audit_events (operation_id, id);
create index audit_delegation on authority.audit_events (delegation_id, id);
create index audit_correlation on authority.audit_events (tenant_id, correlation_id, id);

create function authority.audit_append_only() returns trigger language plpgsql as $$
begin raise exception 'audit_events is append-only'; end $$;
create trigger audit_no_update before update or delete on authority.audit_events
  for each row execute function authority.audit_append_only();

create table authority.idempotency_keys (
  tenant_id text not null,
  scope text not null,
  key text not null,
  request_hash text not null,
  status integer not null,
  response jsonb not null,
  created_at timestamptz not null,
  primary key (tenant_id, scope, key)
);

create table authority.used_decision_tokens (
  tenant_id text not null,
  jti text not null,
  approval_id text not null,
  primary key (tenant_id, jti)
);

create table authority.usage_counters (
  tenant_id text not null,
  day date not null,
  metric text not null,
  count bigint not null default 0,
  primary key (tenant_id, day, metric)
);
