# Cumulus Drive storage (free filesystem)

This supersedes the dataset-publishing design in pull request #1 (`8de6904`). That design is not the implementation. Mail, dataset publishing, compute, payments, tokens, and Google or Proton code are out of scope.

Drive is private file storage inside Cumulus://Cloud:

- Bytes: local directory `CUMULUS_BLOB_ROOT`, mode 0700/0600, no symlink roots, server-built keys only.
- Metadata: file-backed PGLite at `CUMULUS_PGLITE_DIR` (not in-memory). `DATABASE_URL` is refused so this build cannot use hosted Postgres.
- Hosted ephemeral disk (`VERCEL` or `GROK_PROJECT_ID`) is refused.
- Identity: Better Auth email and password session. `dev-user` is rejected.
- Quota is reserved in the same database transaction as the pending row, including in-flight uploads.
- Shares are one file, explicit `consent: true`, expiring, stored as a hash, revoked by a database flag, and downloaded through the server. Presigned URLs are not issued.
- `BlobStore` is the seam for a later R2 adapter. Copying existing bytes and switching config is still a migration.

Operator steps and the recovery procedure are in `docs/drive-storage.md`.
