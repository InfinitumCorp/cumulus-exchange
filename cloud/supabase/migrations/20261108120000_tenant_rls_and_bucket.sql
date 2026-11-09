-- Harden tenant rows and create the private Drive bucket.
-- Do not apply this file to the live project ivqiskeziohbbtkcvlun from CI or from this repo's scripts.
--
-- cumulus.tenants is SELECT-only for authenticated. Inserts and updates of
-- max_bytes and used_bytes are service_role, or the security-definer quota
-- trigger (it runs as its owner and bypasses row level security).
-- The project-wide access token hook is removed. cid comes from cumulus.identities
-- keyed by the verified JWT sub, in the Edge Function and in cumulus.current_cid().

create or replace function cumulus.current_cid()
returns text
language plpgsql
stable
security definer
set search_path = cumulus
as $$
declare
  raw text := cumulus.jwt_claims() ->> 'sub';
begin
  if raw is null or raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return (select cid from cumulus.identities where user_id = raw::uuid);
end;
$$;

revoke all on function cumulus.current_cid() from public;
grant execute on function cumulus.current_cid() to authenticated, service_role;

drop function if exists public.custom_access_token_hook(jsonb);

revoke all on table cumulus.identities from supabase_auth_admin;
revoke usage on schema cumulus from supabase_auth_admin;

revoke insert, update, delete on table cumulus.identities from anon, authenticated;
revoke insert, update, delete on table cumulus.tenants from anon, authenticated;
grant select on table cumulus.identities to authenticated;
grant select on table cumulus.tenants to authenticated;

drop policy if exists tenants_own on cumulus.tenants;
drop policy if exists tenants_select on cumulus.tenants;
create policy tenants_select on cumulus.tenants
  for select to authenticated
  using (cid = cumulus.current_cid());

-- Private bucket. 50 MB is 50000000 bytes, the same cap the Drive function enforces.
insert into storage.buckets (id, name, public, file_size_limit)
values ('cumulus-drive', 'cumulus-drive', false, 50000000)
on conflict (id) do update
set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit;

-- No anon, authenticated, or public policy on storage.objects.
-- Direct Storage REST calls stay denied. The Drive function uses the S3 protocol.
do $$
declare
  pol record;
begin
  for pol in
    select p.polname
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage'
      and c.relname = 'objects'
      and (
        cardinality(p.polroles) = 0
        or exists (
          select 1
          from unnest(p.polroles) as role_oid
          join pg_roles r on r.oid = role_oid
          where r.rolname in ('anon', 'authenticated', 'public')
        )
      )
  loop
    execute format('drop policy %I on storage.objects', pol.polname);
  end loop;
end $$;
