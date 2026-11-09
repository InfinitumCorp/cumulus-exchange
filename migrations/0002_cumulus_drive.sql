-- Private Drive metadata. Bytes live on the local blob volume, not in these rows.
-- Names and paths stay on drive_object and are never copied into a public document.

create table drive_quota (
  owner_user_id text primary key references "user" ("id"),
  byte_quota integer not null check (byte_quota > 0),
  bytes_reserved integer not null default 0 check (bytes_reserved >= 0),
  bytes_stored integer not null default 0 check (bytes_stored >= 0),
  constraint drive_quota_within check (bytes_reserved + bytes_stored <= byte_quota)
);

create table drive_object (
  id text primary key,
  owner_user_id text not null references "user" ("id"),
  byte_size integer not null check (byte_size > 0),
  media_type text not null,
  sha256 text not null,
  display_name text not null,
  object_key text not null unique,
  status text not null check (status in ('pending', 'stored', 'aborted', 'deleting', 'deleted')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  stored_at timestamptz,
  unique (owner_user_id, idempotency_key)
);

create index drive_object_owner_idx on drive_object (owner_user_id);

create table drive_share (
  id text primary key,
  object_id text not null references drive_object (id),
  owner_user_id text not null references "user" ("id"),
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index drive_share_object_idx on drive_share (object_id);

create table drive_audit (
  id text primary key,
  actor_user_id text not null,
  action text not null check (action in (
    'upload_stored', 'upload_aborted', 'download', 'delete', 'share_create', 'share_revoke', 'share_download'
  )),
  object_id text,
  share_id text,
  at timestamptz not null default now()
);
