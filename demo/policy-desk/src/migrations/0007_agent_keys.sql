-- Sandbox agent keys (agent-keys.ts): Auth0 access tokens of the external agent client that
-- a visitor connected to their sandbox. Only a SHA-256 of the token is stored. A token of
-- that client is accepted only while its row exists and has not expired; replacing or
-- disconnecting the key deletes the row, and TTL cleanup deletes rows with their sandbox.
create table if not exists policy_desk.agent_keys (
  token_hash text primary key,
  sandbox_id text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  last_used_at timestamptz
);
create index if not exists agent_keys_sandbox on policy_desk.agent_keys (sandbox_id);
create index if not exists agent_keys_expiry on policy_desk.agent_keys (expires_at);

alter table policy_desk.agent_keys enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on policy_desk.agent_keys from %I', r);
    end if;
  end loop;
end $$;
