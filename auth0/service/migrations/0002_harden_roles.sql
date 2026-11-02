-- Defense in depth for hosted Postgres (e.g. Supabase). The service connects with its own
-- owner role; no API role may read or write authorization state.
alter table authority.delegations enable row level security;
alter table authority.operations enable row level security;
alter table authority.approvals enable row level security;
alter table authority.claims enable row level security;
alter table authority.audit_events enable row level security;
alter table authority.idempotency_keys enable row level security;
alter table authority.used_decision_tokens enable row level security;
alter table authority.usage_counters enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema authority from %I', r);
      execute format('revoke all on all tables in schema authority from %I', r);
      execute format('revoke all on all sequences in schema authority from %I', r);
    end if;
  end loop;
end $$;
