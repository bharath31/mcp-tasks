-- Single-use DPoP proofs for the Worker's own endpoints (see src/dpop.ts).
create table if not exists policy_desk.used_dpop_proofs (
  jkt text not null,
  jti text not null,
  expires_at timestamptz not null,
  primary key (jkt, jti)
);
create index if not exists used_dpop_proofs_expires_idx on policy_desk.used_dpop_proofs (expires_at);
