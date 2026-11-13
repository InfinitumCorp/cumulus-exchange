-- Drive parity for the hosted function: stars, trash, previews, sealed names, activity.
-- Additive only: existing objects keep working (not starred, not trashed, no preview class).
-- The console's cloud Drive view sends these fields and reads these views
-- (src/components/exchange/drive.tsx); cloud/src/parity.mjs is the Node equivalent.

alter table cumulus.objects add column if not exists starred boolean not null default false;
alter table cumulus.objects add column if not exists trashed_at text;
alter table cumulus.objects add column if not exists preview_class text;
alter table cumulus.objects add column if not exists sealed_name text;

alter table cumulus.objects drop constraint if exists objects_preview_class_check;
alter table cumulus.objects add constraint objects_preview_class_check
  check (preview_class is null or preview_class in ('image', 'pdf', 'text', 'video', 'note', 'other'));

alter table cumulus.objects drop constraint if exists objects_sealed_name_check;
alter table cumulus.objects add constraint objects_sealed_name_check
  check (sealed_name is null or length(sealed_name) <= 2048);

create table if not exists cumulus.activity (
  id text primary key,
  tenant_id text not null references cumulus.tenants (id),
  action text not null check (action in ('upload', 'delete', 'trash', 'restore', 'star', 'unstar', 'share')),
  object_key text,
  at text not null
);

create index if not exists activity_tenant_at_idx on cumulus.activity (tenant_id, at desc);

alter table cumulus.activity enable row level security;

grant select, insert on table cumulus.activity to authenticated, service_role;

drop policy if exists activity_own on cumulus.activity;
create policy activity_own on cumulus.activity
  for all to authenticated
  using (
    tenant_id in (select id from cumulus.tenants where cid = cumulus.current_cid())
  )
  with check (
    tenant_id in (select id from cumulus.tenants where cid = cumulus.current_cid())
  );

-- Keep the newest 200 events per tenant. The console shows the latest 50, and
-- the free project's database is small, so older rows are pruned on insert.
-- security definer: in supabase mode the inserting role (authenticated) has no
-- DELETE on this table, and should not get one.
create or replace function cumulus.prune_activity()
returns trigger
language plpgsql
security definer
set search_path = cumulus
as $$
begin
  delete from cumulus.activity
  where tenant_id = new.tenant_id
    and id in (
      select id from cumulus.activity
      where tenant_id = new.tenant_id
      order by at desc, id desc
      offset 200
    );
  return null;
end;
$$;

revoke all on function cumulus.prune_activity() from public;

drop trigger if exists activity_prune on cumulus.activity;
create trigger activity_prune
  after insert on cumulus.activity
  for each row execute function cumulus.prune_activity();
