



create schema if not exists cumulus;

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

alter table cumulus.tenants enable row level security;
alter table cumulus.objects enable row level security;
alter table cumulus.shares enable row level security;
revoke all on schema cumulus from public, anon, authenticated;
revoke all on all tables in schema cumulus from public, anon, authenticated;
insert into storage.buckets (id, name, public, file_size_limit)
values ('cumulus-drive', 'cumulus-drive', false, 50000000)
on conflict (id) do nothing;

