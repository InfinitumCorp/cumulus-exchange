-- Pin search_path on cumulus.jwt_claims (Supabase security advisor 0011, function_search_path_mutable).
-- The function only calls pg_catalog built-ins (current_setting, nullif, coalesce, the jsonb cast), which are
-- always found, so an empty search_path changes nothing it does; it just stops a caller's search_path from
-- changing what it resolves.
alter function cumulus.jwt_claims() set search_path = '';
