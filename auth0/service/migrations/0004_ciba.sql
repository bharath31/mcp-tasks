-- CIBA/RAR approval channel: the service initiates a backchannel authentication request
-- (durable intent first), then polls for the outcome. The reviewer subject is a hint only.
alter table authority.approvals add column ciba_auth_req_id text;
alter table authority.approvals add column reviewer_subject text;
create unique index approvals_ciba_req on authority.approvals (ciba_auth_req_id) where ciba_auth_req_id is not null;
