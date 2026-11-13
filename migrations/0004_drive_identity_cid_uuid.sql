-- Cumulus ID mints `cid_<uuid>` (hyphens included). 0003 allowed only
-- `cid_<lowercase_word>`, which rejected those identities. Widen the check.
alter table drive_identity drop constraint if exists drive_identity_cid_check;
alter table drive_identity add constraint drive_identity_cid_check check (cid ~ '^cid_[a-z0-9_-]{1,64}$');
