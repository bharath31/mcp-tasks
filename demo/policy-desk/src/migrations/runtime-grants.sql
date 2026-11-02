-- Re-run after every migration by tools/migrate.ts (not a tracked migration, so new
-- tables are covered). Grants the runtime role DML only: no ownership, no DDL.
do $$
declare t text;
begin
  if not exists (select 1 from pg_roles where rolname = 'policy_desk_runtime') then
    raise notice 'policy_desk_runtime does not exist; skipping runtime grants';
    return;
  end if;
  grant usage on schema authority, policy_desk to policy_desk_runtime;
  grant select, insert, update, delete on all tables in schema authority, policy_desk to policy_desk_runtime;
  grant usage, select on all sequences in schema authority, policy_desk to policy_desk_runtime;
  grant execute on function policy_desk.wipe_tenants(text[]) to policy_desk_runtime;
  -- Row-level security is on to keep Supabase's API roles out; the runtime role gets an
  -- explicit allow-all policy on each such table (the owner bypasses RLS, the runtime role does not).
  for t in
    select format('%I.%I', schemaname, tablename) from pg_tables
    where schemaname in ('authority', 'policy_desk') and rowsecurity
  loop
    execute format('drop policy if exists policy_desk_runtime_all on %s', t);
    execute format('create policy policy_desk_runtime_all on %s for all to policy_desk_runtime using (true) with check (true)', t);
  end loop;
end $$;
