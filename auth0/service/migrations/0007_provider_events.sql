create table authority.provider_events (
  tenant_id text not null,
  provider_reference text not null,
  organization_id text not null,
  action text not null,
  resource text not null,
  claim_id text references authority.claims(id),
  received_at timestamptz not null,
  primary key(tenant_id,provider_reference)
);
create unique index provider_effect_per_claim on authority.provider_events(claim_id) where claim_id is not null;
alter table authority.provider_events enable row level security;
revoke all on authority.provider_events from public;

create table authority.reviewer_digests (
  tenant_id text not null,
  reviewer_id text not null,
  sent_at timestamptz not null,
  primary key(tenant_id,reviewer_id)
);
alter table authority.reviewer_digests enable row level security;
revoke all on authority.reviewer_digests from public;
