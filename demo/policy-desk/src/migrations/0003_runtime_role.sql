-- Least-privilege runtime. The Worker should connect as policy_desk_runtime, which
-- has DML on the tables but owns nothing, so it cannot ALTER TABLE ... DISABLE TRIGGER
-- and the append-only audit and policy-version guarantees hold even if the Worker is
-- compromised. The one place those triggers must be lifted, TTL cleanup of sandbox
-- tenants, is this SECURITY DEFINER function owned by the migration (owner) role. It
-- refuses any tenant id that is not a sandbox tenant (pd_<24 hex>_g<n>).
create or replace function policy_desk.wipe_tenants(ids text[]) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare t text;
begin
  if ids is null or cardinality(ids) = 0 then return 0; end if;
  foreach t in array ids loop
    if t is null or t !~ '^pd_[a-f0-9]{24}_g[0-9]+$' then
      raise exception 'wipe_tenants refuses tenant id %', coalesce(t, 'null');
    end if;
  end loop;
  set local lock_timeout = '5s';
  alter table authority.audit_events disable trigger audit_no_update;
  alter table authority.policy_versions disable trigger policy_versions_immutable;
  delete from authority.approval_decisions where approval_id in (select id from authority.approvals where tenant_id = any(ids));
  delete from authority.approval_challenges where tenant_id = any(ids);
  delete from authority.provider_events where tenant_id = any(ids);
  delete from authority.policy_budget_consumption where tenant_id = any(ids);
  delete from authority.claims where tenant_id = any(ids);
  delete from authority.approvals where tenant_id = any(ids);
  delete from authority.operations where tenant_id = any(ids);
  delete from authority.delegations where tenant_id = any(ids);
  delete from authority.audit_events where tenant_id = any(ids);
  delete from authority.policy_state where tenant_id = any(ids);
  delete from authority.policy_versions where tenant_id = any(ids);
  delete from authority.idempotency_keys where tenant_id = any(ids);
  delete from authority.used_decision_tokens where tenant_id = any(ids);
  delete from authority.usage_counters where tenant_id = any(ids);
  delete from authority.reviewer_sessions where tenant_id = any(ids);
  delete from authority.reviewer_digests where tenant_id = any(ids);
  delete from authority.used_dpop_proofs where tenant_id = any(ids);
  delete from policy_desk.refunds where tenant_id = any(ids);
  delete from policy_desk.orders where tenant_id = any(ids);
  delete from policy_desk.fga_tuples where tenant_id = any(ids);
  alter table authority.audit_events enable trigger audit_no_update;
  alter table authority.policy_versions enable trigger policy_versions_immutable;
  return cardinality(ids);
end $$;
revoke all on function policy_desk.wipe_tenants(text[]) from public;
