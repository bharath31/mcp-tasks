-- The refund agent's conversation, kept on the server so it survives tab switches,
-- reloads and new browser tabs. One row per sandbox generation (tenant): a sandbox reset
-- starts a fresh conversation, and TTL cleanup deletes it with the tenant (cleanup.ts).
-- history is what the model reads (OpenAI-style messages); turns is what the UI shows,
-- including each tool call's MCP exchanges.
create table if not exists policy_desk.agent_conversations (
  tenant_id text primary key,
  sandbox_id text not null,
  history jsonb not null default '[]'::jsonb,
  turns jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null
);
create index if not exists agent_conversations_sandbox on policy_desk.agent_conversations (sandbox_id);

alter table policy_desk.agent_conversations enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on policy_desk.agent_conversations from %I', r);
    end if;
  end loop;
end $$;
