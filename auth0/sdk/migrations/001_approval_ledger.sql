create table if not exists approval_requests (
  id text primary key,
  request jsonb not null,
  proof text,
  decided_at timestamptz,
  used_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint approval_requests_request_id_matches check (request->>'id' = id)
);

create index if not exists approval_requests_expiry_idx
  on approval_requests (expires_at)
  where used_at is null;
