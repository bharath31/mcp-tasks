-- Customer-owned state ONLY: MCP task records, signed warehouse events and the
-- labelled provider simulator ledger. There are deliberately no tables for
-- delegations, approvals, claims or FGA membership: those live in the
-- Task Authority service and are reached only through the SDK.
create schema if not exists refund_desk;

create table refund_desk.tasks (
  task_id uuid primary key,
  owner_sub text not null,
  org_id text not null,
  agent_id text not null,
  operation_key text not null,
  delegation_id text,
  operation_id text,
  operation_digest text,
  request jsonb not null,
  payment jsonb,
  status text not null check (status in ('working','input_required','completed','failed','cancelled')),
  stage text not null check (stage in ('awaiting_input','awaiting_return','awaiting_approval','ready','dispatching','reconciling','finished')),
  status_message text,
  input_requests jsonb,
  answered_inputs jsonb not null default '[]',
  result jsonb,
  error jsonb,
  receipt jsonb,
  attempts integer not null default 0,
  failures integer not null default 0,
  claim_id text,
  provider_reference text,
  dispatched_at timestamptz,
  next_run_at timestamptz not null,
  poll_interval_ms integer not null default 5000,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  retain_until timestamptz not null,
  version integer not null default 1,
  unique (org_id, operation_key)
);
create index tasks_due on refund_desk.tasks (next_run_at) where status in ('working','input_required');
create index tasks_match on refund_desk.tasks (org_id, (request->>'orderId'), (request->>'paymentId'));

create table refund_desk.task_events (
  id bigserial primary key,
  task_id uuid not null references refund_desk.tasks (task_id),
  at timestamptz not null,
  actor text not null,
  event text not null,
  detail text not null
);

-- Signed warehouse events, de-duplicated atomically by event id.
create table refund_desk.warehouse_events (
  event_id text primary key,
  org_id text not null,
  order_id text not null,
  payment_id text not null,
  reference text not null,
  received_at timestamptz not null,
  applied_task_id uuid
);

-- Provider SIMULATOR ledger (CI, fault injection, and demos without Stripe).
-- Not Stripe. Selected only when PAYMENTS_MODE=simulator.
create table refund_desk.sim_payments (
  payment_id text primary key,
  org_id text not null,
  amount_minor integer not null,
  currency text not null,
  refunded_minor integer not null default 0
);
create table refund_desk.sim_refunds (
  refund_id text primary key,
  payment_id text not null references refund_desk.sim_payments (payment_id),
  idempotency_key text not null unique,
  amount_minor integer not null,
  status text not null,
  created_at timestamptz not null
);
