-- Cumulus Drive metadata and quotas.
-- Apply only to a local Postgres. The migrate script refuses the live
-- Supabase project (ivqiskeziohbbtkcvlun). This file is not applied by CI.

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
