-- Trigger functions reference only NEW/OLD, so an empty search_path is safe and removes a
-- search-path hijack surface (flagged by the Supabase security advisor).
alter function authority.delegations_immutable() set search_path = '';
alter function authority.operations_immutable() set search_path = '';
alter function authority.audit_append_only() set search_path = '';
