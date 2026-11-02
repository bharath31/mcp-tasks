-- The Auth0-signed approve() proof path stores the signed request and one
-- delivered proof here. It stays inside the sandbox's Postgres database.
create table if not exists policy_desk.approval_requests (
  id text primary key,
  request jsonb not null,
  proof text,
  decided_at timestamptz,
  used_at timestamptz,
  cancelled_at timestamptz,
  expires_at timestamptz not null,
  tenant_id text,
  sandbox_id text,
  generation integer,
  created_at timestamptz not null default now(),
  constraint approval_requests_request_id_matches check (request->>'id' = id)
);
create index if not exists approval_requests_expiry_idx
  on policy_desk.approval_requests (expires_at)
  where used_at is null;
create index if not exists approval_requests_sandbox_idx
  on policy_desk.approval_requests (sandbox_id, generation, created_at);
create unique index if not exists approval_requests_run_idx
  on policy_desk.approval_requests (tenant_id, sandbox_id, generation, (request->>'run'));
alter table policy_desk.approval_requests enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table policy_desk.approval_requests from %I', r);
    end if;
  end loop;
end $$;
