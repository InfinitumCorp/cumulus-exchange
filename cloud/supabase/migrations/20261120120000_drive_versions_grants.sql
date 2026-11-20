-- Versions, Cumulus ID grants, and password/download-limited shares for the hosted Drive.
-- Additive. Existing objects, shares, and activity rows stay valid.
-- Do not apply this file to the live project from CI. cloud/DEPLOY.md is the operator step.

alter table cumulus.shares add column if not exists password_hash text;
alter table cumulus.shares add column if not exists max_downloads integer;
alter table cumulus.shares add column if not exists download_count integer not null default 0;

alter table cumulus.shares drop constraint if exists shares_max_downloads_check;
alter table cumulus.shares add constraint shares_max_downloads_check
  check (max_downloads is null or (max_downloads >= 1 and max_downloads <= 10000));

create table if not exists cumulus.versions (
  id text primary key,
  tenant_id text not null references cumulus.tenants (id),
  bucket text not null,
  object_key text not null,
  size_bytes bigint not null,
  blob_id text not null,
  sha256 text not null,
  plaintext_sha256 text not null,
  content_type text not null,
  envelope_json text not null,
  created_at text not null
);

create index if not exists versions_object_idx
  on cumulus.versions (tenant_id, bucket, object_key, created_at desc);

create table if not exists cumulus.grants (
  id text primary key,
  tenant_id text not null references cumulus.tenants (id),
  bucket text not null,
  object_key text not null,
  grantee_cid text not null,
  role text not null check (role in ('viewer', 'editor')),
  created_at text not null,
  revoked_at text,
  check (grantee_cid ~ '^cid_[a-z0-9_-]{1,64}$')
);

create index if not exists grants_grantee_idx
  on cumulus.grants (grantee_cid)
  where revoked_at is null;

alter table cumulus.versions enable row level security;
alter table cumulus.grants enable row level security;

grant select, insert, update, delete on table cumulus.versions to authenticated, service_role;
grant select, insert, update, delete on table cumulus.grants to authenticated, service_role;

drop policy if exists versions_own on cumulus.versions;
create policy versions_own on cumulus.versions
  for all to authenticated
  using (
    tenant_id in (select id from cumulus.tenants where cid = cumulus.current_cid())
  )
  with check (
    tenant_id in (select id from cumulus.tenants where cid = cumulus.current_cid())
  );

drop policy if exists grants_own on cumulus.grants;
create policy grants_own on cumulus.grants
  for all to authenticated
  using (
    tenant_id in (select id from cumulus.tenants where cid = cumulus.current_cid())
  )
  with check (
    tenant_id in (select id from cumulus.tenants where cid = cumulus.current_cid())
  );

drop policy if exists grants_grantee on cumulus.grants;
create policy grants_grantee on cumulus.grants
  for select to authenticated
  using (grantee_cid = cumulus.current_cid() and revoked_at is null);

-- Activity gained invite and version rows. Drop whatever check name the earlier migration used.
do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'cumulus' and rel.relname = 'activity' and con.contype = 'c'
  loop
    execute format('alter table cumulus.activity drop constraint %I', r.conname);
  end loop;
end $$;

alter table cumulus.activity add constraint activity_action_check
  check (action in ('upload', 'delete', 'trash', 'restore', 'star', 'unstar', 'share', 'invite', 'version'));

-- Kept copies are not a second objects row, so the objects quota trigger does not see them.
-- The Drive function calls this as service_role. authenticated cannot change a quota.
create or replace function cumulus.note_retained_bytes(p_tenant text, p_delta bigint)
returns void
language plpgsql
security definer
set search_path = cumulus
as $$
declare
  tenant cumulus.tenants%rowtype;
begin
  if p_delta = 0 then
    return;
  end if;
  select * into tenant from cumulus.tenants where id = p_tenant for update;
  if tenant.id is null then
    raise exception 'tenant' using errcode = '23514';
  end if;
  if p_delta > 0 and tenant.used_bytes + p_delta > tenant.max_bytes then
    raise exception 'quota' using errcode = '23514';
  end if;
  update cumulus.tenants
    set used_bytes = greatest(used_bytes + p_delta, 0)
    where id = p_tenant;
end;
$$;

revoke all on function cumulus.note_retained_bytes(text, bigint) from public, anon, authenticated;
grant execute on function cumulus.note_retained_bytes(text, bigint) to service_role;
