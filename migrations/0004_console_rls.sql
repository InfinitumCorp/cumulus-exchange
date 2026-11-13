-- Keep the console's tables out of Supabase's Data API.
--
-- On the cumulus-cloud Worker deploy (cloud/DEPLOY.md), DATABASE_URL points at the
-- Supabase project, and these tables live in its `public` schema. PostgREST
-- exposes `public` to the `anon` and `authenticated` roles, and Supabase grants
-- those roles access to new tables there. "session" holds bearer session tokens
-- and "account" holds (encrypted) Cumulus ID tokens, so with row level security
-- off anyone holding the project's anon key could read them.
--
-- Row level security with no policies denies those roles every row. The console
-- connects as the role that ran these migrations, which owns the tables and so is
-- not subject to row level security (no FORCE). Elsewhere (Neon, PGLite) this
-- changes nothing for the app.
alter table "user" enable row level security;
alter table "session" enable row level security;
alter table "account" enable row level security;
alter table "verification" enable row level security;
alter table drive_identity enable row level security;
alter table drive_quota enable row level security;
alter table drive_folder enable row level security;
alter table drive_object enable row level security;
alter table drive_upload enable row level security;
alter table drive_upload_part enable row level security;
alter table drive_share enable row level security;
alter table drive_grant enable row level security;
alter table drive_audit enable row level security;
