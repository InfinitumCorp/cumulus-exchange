-- Local and future Supabase metadata for Cumulus Drive.
-- Do not apply this file to the live project ivqiskeziohbbtkcvlun from CI or from this repo's scripts.

create schema if not exists cumulus;

create table if not exists cumulus.identities (
  user_id uuid primary key,
  cid text not null unique
);

create table if not exists cumulus.tenants (
  id text primary key,
  name text not null unique,
  cid text not null unique,
  max_bytes bigint not null,
  max_objects integer not null,
  used_bytes bigint not null default 0,
  used_objects integer not null default 0,
  created_at text not null
);

create table if not exists cumulus.objects (
  tenant_id text not null references cumulus.tenants (id),
  bucket text not null,
  object_key text not null,
  size_bytes bigint not null,
  blob_id text not null unique,
  sha256 text not null,
  plaintext_sha256 text not null,
  content_type text not null,
  envelope_json text not null,
  created_at text not null,
  primary key (tenant_id, bucket, object_key)
);

create table if not exists cumulus.shares (
  id text primary key,
  tenant_id text not null references cumulus.tenants (id),
  bucket text not null,
  object_key text not null,
  expires_at text not null,
  revoked_at text,
  created_at text not null
);

create index if not exists objects_tenant_bucket_idx
  on cumulus.objects (tenant_id, bucket);

alter table cumulus.identities enable row level security;
alter table cumulus.tenants enable row level security;
alter table cumulus.objects enable row level security;
alter table cumulus.shares enable row level security;

create or replace function cumulus.jwt_claims()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    nullif(current_setting('request.jwt.claim', true), '')
  )::jsonb;
$$;

create or replace function cumulus.current_cid()
returns text
language sql
stable
as $$
  select cumulus.jwt_claims() -> 'app_metadata' ->> 'cid';
$$;

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, cumulus
as $$
declare
  claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  uid uuid := nullif(event ->> 'user_id', '')::uuid;
  user_cid text;
begin
  if uid is not null then
    select cid into user_cid from cumulus.identities where user_id = uid;
  end if;
  if user_cid is not null then
    claims := jsonb_set(
      claims,
      '{app_metadata}',
      coalesce(claims -> 'app_metadata', '{}'::jsonb) || jsonb_build_object('cid', user_cid),
      true
    );
  end if;
  return jsonb_set(event, '{claims}', claims, true);
end;
$$;

revoke all on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant usage on schema cumulus to supabase_auth_admin;
grant select on table cumulus.identities to supabase_auth_admin;

grant usage on schema cumulus to authenticated, service_role;
grant select, insert, update, delete on all tables in schema cumulus to authenticated, service_role;

create policy identities_own on cumulus.identities
  for select to authenticated
  using (user_id = ((cumulus.jwt_claims() ->> 'sub')::uuid));

create policy tenants_own on cumulus.tenants
  for all to authenticated
  using (cid = cumulus.current_cid())
  with check (cid = cumulus.current_cid());

create policy objects_own on cumulus.objects
  for all to authenticated
  using (
    tenant_id in (select id from cumulus.tenants where cid = cumulus.current_cid())
  )
  with check (
    tenant_id in (select id from cumulus.tenants where cid = cumulus.current_cid())
  );

create policy shares_own on cumulus.shares
  for all to authenticated
  using (
    tenant_id in (select id from cumulus.tenants where cid = cumulus.current_cid())
  )
  with check (
    tenant_id in (select id from cumulus.tenants where cid = cumulus.current_cid())
  );

create or replace function cumulus.enforce_object_quota()
returns trigger
language plpgsql
security definer
set search_path = cumulus
as $$
declare
  tenant cumulus.tenants%rowtype;
  delta_bytes bigint;
  delta_objects integer;
  raw_claims text := nullif(current_setting('request.jwt.claims', true), '');
begin
  -- The Node Drive process accounts for quotas itself and does not set JWT claims.
  -- The Edge Function sets claims and relies on this trigger.
  if raw_claims is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.size_bytes > 50000000 then
      raise exception 'file cap' using errcode = '23514';
    end if;
    select * into tenant from cumulus.tenants where id = new.tenant_id for update;
    delta_bytes := new.size_bytes;
    delta_objects := 1;
    if tenant.used_bytes + delta_bytes > tenant.max_bytes or tenant.used_objects + delta_objects > tenant.max_objects then
      raise exception 'quota' using errcode = '23514';
    end if;
    update cumulus.tenants
      set used_bytes = used_bytes + delta_bytes, used_objects = used_objects + delta_objects
      where id = tenant.id;
    return new;
  elsif tg_op = 'DELETE' then
    update cumulus.tenants
      set used_bytes = greatest(used_bytes - old.size_bytes, 0),
          used_objects = greatest(used_objects - 1, 0)
      where id = old.tenant_id;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists objects_quota on cumulus.objects;
create trigger objects_quota
  before insert or delete on cumulus.objects
  for each row execute function cumulus.enforce_object_quota();
