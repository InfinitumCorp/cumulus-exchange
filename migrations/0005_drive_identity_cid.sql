-- Cumulus://ID subjects are cid_<uuid>. The earlier check only allowed cid_<word>.

do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where rel.relname = 'drive_identity'
      and con.contype = 'c'
      and nsp.nspname = current_schema()
  loop
    execute format('alter table drive_identity drop constraint %I', r.conname);
  end loop;
end $$;

alter table drive_identity add constraint drive_identity_cid_check
  check (cid ~ '^cid_[a-z0-9_-]{1,64}$');
