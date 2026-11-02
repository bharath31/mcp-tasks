-- Immutable policy versions, mutable activation pointers and atomic budget holds.
create table authority.policy_versions (
 tenant_id text not null, resource_server text not null, version text not null,
 document jsonb not null, created_by text not null, created_at timestamptz not null,
 primary key(tenant_id,resource_server,version)
);
create trigger policy_versions_immutable before update or delete on authority.policy_versions
 for each row execute function authority.audit_append_only();
create table authority.policy_state (
 tenant_id text not null,resource_server text not null,active_version text,shadow_version text,
 primary key(tenant_id,resource_server),
 foreign key(tenant_id,resource_server,active_version) references authority.policy_versions(tenant_id,resource_server,version),
 foreign key(tenant_id,resource_server,shadow_version) references authority.policy_versions(tenant_id,resource_server,version)
);
alter table authority.operations alter column delegation_id drop not null;
alter table authority.claims alter column delegation_id drop not null;
alter table authority.operations add column resource_server text, add column facts jsonb not null default '{}',
 add column actor jsonb not null default '{}',add column policy_version text,
 add column rule_ids text[] not null default '{}',add column decision text not null default 'deny',
 add column reason_code text not null default 'policy_not_configured',
 add column policy_details jsonb not null default '{}';
update authority.operations set resource_server=scope;
-- Operations registered before policies existed were authorized by approval_requirement alone.
-- Derive their decision from it so in-flight work is neither denied nor silently loosened.
update authority.operations set
 decision=case when approval_requirement='human' then 'approval_required' else 'allow' end,
 reason_code=case when approval_requirement='human' then 'pre_policy_approval_required' else 'pre_policy_allowed' end,
 policy_details=jsonb_build_object(
  'decision',case when approval_requirement='human' then 'approval_required' else 'allow' end,
  'reasonCode',case when approval_requirement='human' then 'pre_policy_approval_required' else 'pre_policy_allowed' end,
  'policyVersion',null,'ruleIds','[]'::jsonb,'budgetRuleIds','[]'::jsonb)
 where decision='deny' and reason_code='policy_not_configured';
alter table authority.operations alter column resource_server set not null;
create function authority.operation_policy_immutable() returns trigger language plpgsql set search_path=pg_catalog,authority as $$
begin
 if (new.facts,new.actor,new.policy_version,new.resource_server) is distinct from (old.facts,old.actor,old.policy_version,old.resource_server)
 then raise exception 'operation facts, actor and policy version are immutable'; end if;
 return new;
end $$;
create trigger operation_policy_immutable before update on authority.operations
 for each row execute function authority.operation_policy_immutable();
-- A lapsed hold may raise the effective requirement. It may never lower it.
create or replace function authority.operations_immutable() returns trigger language plpgsql set search_path=pg_catalog,authority as $$
begin
 if (new.id,new.tenant_id,new.organization_id,new.delegation_id,new.operation_key,new.action,new.resource,new.scope,new.arguments,new.canonical_version,new.canonical,new.digest,new.business_state_version)
 is distinct from (old.id,old.tenant_id,old.organization_id,old.delegation_id,old.operation_key,old.action,old.resource,old.scope,old.arguments,old.canonical_version,old.canonical,old.digest,old.business_state_version)
 or (old.approval_requirement='human' and new.approval_requirement<>'human')
 then raise exception 'protected operation fields are immutable'; end if;
 return new;
end $$;
create table authority.policy_budget_consumption (
 id bigserial primary key,tenant_id text not null,resource_server text not null,policy_version text not null,
 rule_id text not null,scope_key text not null,operation_id text not null references authority.operations(id),
 claim_id text references authority.claims(id),amount_minor bigint not null check(amount_minor>=0),
 consumed_at timestamptz not null,hold_expires_at timestamptz not null,
 status text not null check(status in ('held','captured','released')),
 unique(operation_id,rule_id)
);
create index budget_window on authority.policy_budget_consumption(tenant_id,resource_server,rule_id,scope_key,consumed_at);
alter table authority.policy_versions enable row level security;
alter table authority.policy_state enable row level security;
alter table authority.policy_budget_consumption enable row level security;
do $$ declare r text; begin
 foreach r in array array['anon','authenticated','service_role'] loop
 if exists(select 1 from pg_roles where rolname=r) then
 execute format('revoke all on all tables in schema authority from %I',r);
 execute format('revoke all on all sequences in schema authority from %I',r);
 end if; end loop;
end $$;
