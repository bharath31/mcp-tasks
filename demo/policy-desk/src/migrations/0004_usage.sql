-- Usage history for the operator's /admin page. These rows are not tenant-scoped and
-- wipe_tenants never touches them, so who used the demo and how much survives the
-- sandbox TTL cleanup.

-- One row per real Auth0 user who reached the sandbox API. The email comes from the
-- visitor's own Auth0 ID token (verified signature, same subject as the access token).
create table if not exists policy_desk.visitors (
  sub text primary key,
  sandbox_id text not null,
  email text,
  email_verified boolean not null default false,
  name text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null
);
create index if not exists visitors_sandbox on policy_desk.visitors (sandbox_id);
create index if not exists visitors_last_seen on policy_desk.visitors (last_seen_at);

-- Append-only log of what visitors did: sandbox_created, sandbox_reset, scenario_run,
-- policy_published, simulation, and model_call (the AI agent, with token counts).
create table if not exists policy_desk.usage_events (
  id bigserial primary key,
  at timestamptz not null,
  sandbox_id text not null,
  kind text not null,
  detail jsonb,
  model text,
  input_tokens integer,
  output_tokens integer
);
create index if not exists usage_events_at on policy_desk.usage_events (at);
create index if not exists usage_events_sandbox on policy_desk.usage_events (sandbox_id, at);

-- Per-tenant Task Authority totals, written in the same transaction that wipes the
-- tenant, so approvals and refunds stay countable after the rows themselves are gone.
create table if not exists policy_desk.tenant_usage (
  id bigserial primary key,
  tenant_id text not null,
  sandbox_id text not null,
  operations integer not null default 0,
  auto_allowed integer not null default 0,
  denied integer not null default 0,
  approvals_requested integer not null default 0,
  approvals_approved integer not null default 0,
  approvals_rejected integer not null default 0,
  refunds_executed integer not null default 0,
  policy_versions integer not null default 0,
  archived_at timestamptz not null
);
create index if not exists tenant_usage_sandbox on policy_desk.tenant_usage (sandbox_id);

alter table policy_desk.visitors enable row level security;
alter table policy_desk.usage_events enable row level security;
alter table policy_desk.tenant_usage enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema policy_desk from %I', r);
      execute format('revoke all on all sequences in schema policy_desk from %I', r);
    end if;
  end loop;
end $$;
