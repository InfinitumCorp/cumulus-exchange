-- Proton Drive parity metadata. Bytes stay on the blob volume.
-- Existing upload, share, quota, and delete behavior stays valid:
-- trash is a timestamp, versions stay stored, and DELETE still removes a file.

alter table drive_object add column folder_id text;
alter table drive_object add column trashed_at timestamptz;
alter table drive_object add column starred boolean not null default false;
alter table drive_object add column version_group text;
alter table drive_object add column version_number integer not null default 1;
alter table drive_object add column is_current boolean not null default true;
alter table drive_object add column preview_class text;

alter table drive_object drop constraint if exists drive_object_preview_class_check;
alter table drive_object add constraint drive_object_preview_class_check
  check (preview_class is null or preview_class in ('image', 'pdf', 'text', 'video', 'note', 'other'));

create table drive_folder (
  id text primary key,
  owner_user_id text not null references "user" ("id"),
  parent_id text references drive_folder (id),
  display_name text not null,
  trashed_at timestamptz,
  created_at timestamptz not null default now()
);

create index drive_folder_owner_idx on drive_folder (owner_user_id);

alter table drive_object drop constraint if exists drive_object_folder_fk;
alter table drive_object add constraint drive_object_folder_fk
  foreign key (folder_id) references drive_folder (id);

alter table drive_share add column password_hash text;
alter table drive_share add column max_downloads integer;
alter table drive_share add column download_count integer not null default 0;
alter table drive_share drop constraint if exists drive_share_max_downloads_check;
alter table drive_share add constraint drive_share_max_downloads_check
  check (max_downloads is null or max_downloads > 0);

create table drive_grant (
  id text primary key,
  object_id text references drive_object (id),
  folder_id text references drive_folder (id),
  owner_user_id text not null references "user" ("id"),
  grantee_user_id text references "user" ("id"),
  grantee_label text not null,
  role text not null check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (object_id is not null or folder_id is not null)
);

create index drive_grant_grantee_idx on drive_grant (grantee_user_id);
create index drive_grant_label_idx on drive_grant (grantee_label);

create table drive_identity (
  user_id text primary key references "user" ("id"),
  cid text not null unique,
  created_at timestamptz not null default now(),
  check (cid ~ '^cid_[a-z0-9_]{1,64}$')
);

create table drive_upload (
  id text primary key,
  owner_user_id text not null references "user" ("id"),
  media_type text not null,
  display_name text not null,
  total_bytes integer not null check (total_bytes > 0),
  part_size integer not null check (part_size > 0),
  parts_expected integer not null check (parts_expected > 0),
  idempotency_key text not null,
  folder_id text,
  version_of text,
  preview_class text,
  status text not null check (status in ('open', 'complete', 'aborted')),
  object_id text,
  created_at timestamptz not null default now(),
  unique (owner_user_id, idempotency_key)
);

create table drive_upload_part (
  upload_id text not null references drive_upload (id),
  part_number integer not null check (part_number > 0),
  byte_size integer not null check (byte_size > 0),
  object_key text not null unique,
  primary key (upload_id, part_number)
);

alter table drive_audit drop constraint if exists drive_audit_action_check;
alter table drive_audit add constraint drive_audit_action_check check (action in (
  'upload_stored', 'upload_aborted', 'download', 'delete',
  'share_create', 'share_revoke', 'share_download',
  'trash', 'restore', 'star', 'version_restore',
  'grant_create', 'grant_revoke', 'mail_handoff', 'upload_part'
));
