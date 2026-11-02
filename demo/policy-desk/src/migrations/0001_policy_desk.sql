-- Policy Desk sandbox host state. Everything lives in the policy_desk schema
-- and is keyed by a per-generation tenant id (pd_<sandbox>_g<n>), so the demo
-- cannot touch any other schema. Task Authority's own tables stay in the
-- authority schema, written only by the service.
create schema if not exists policy_desk;
revoke all on schema policy_desk from public;

create table policy_desk.sandboxes (
  id text primary key,
  org_id text not null,
  generation integer not null default 1,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  last_reset_at timestamptz not null,
  ip_hash text,
  delegation_id text,
  delegation_expires_at timestamptz,
  policy_version text,
  policy_settings jsonb
);
create index sandboxes_expiry on policy_desk.sandboxes (expires_at);

-- Relationship tuples for the Postgres-backed Fga implementation.
create table policy_desk.fga_tuples (
  tenant_id text not null,
  subject text not null,
  relation text not null,
  object text not null,
  primary key (tenant_id, subject, relation, object)
);

-- Labelled payment SIMULATOR: sample orders and the refund ledger. Not Stripe.
create table policy_desk.orders (
  id text primary key,
  tenant_id text not null,
  sandbox_id text not null,
  customer text not null,
  item text not null,
  amount_minor integer not null check (amount_minor > 0),
  refunded_minor integer not null default 0 check (refunded_minor >= 0 and refunded_minor <= amount_minor),
  currency text not null default 'USD',
  created_at timestamptz not null
);
create index orders_tenant on policy_desk.orders (tenant_id, created_at);
create table policy_desk.refunds (
  refund_id text primary key,
  order_id text not null references policy_desk.orders (id),
  tenant_id text not null,
  idempotency_key text not null unique,
  claim_id text,
  amount_minor integer not null,
  status text not null,
  created_at timestamptz not null
);

-- Fixed-window counters for per-IP and per-sandbox abuse limits (IPs are hashed).
create table policy_desk.rate_limits (
  key text not null,
  window_start bigint not null,
  count integer not null,
  primary key (key, window_start)
);

alter table policy_desk.sandboxes enable row level security;
alter table policy_desk.fga_tuples enable row level security;
alter table policy_desk.orders enable row level security;
alter table policy_desk.refunds enable row level security;
alter table policy_desk.rate_limits enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema policy_desk from %I', r);
      execute format('revoke all on all tables in schema policy_desk from %I', r);
    end if;
  end loop;
end $$;
