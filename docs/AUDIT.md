# Cumulus Drive audit

Nothing in this repository is deployed. Tests passing are not an operating environment.

## What this repo already was

`cumulus-exchange` is a browser preview of Cumulus://Cloud. Dataset rows, consent, licenses, and the preview ledger live in `localStorage`. File bytes are not stored. VEIL is a catalog label in the preview seed, not a backend hosted here. Cumulus Mail is out of scope.

A separate readiness note described `infinitum-nexus` (in-memory CloudStore metadata, no blob backend, `nexus-store` as a JSON ledger). That checkout and the live Supabase or Vercel projects were not available here, so those findings stay unverified.

`InfinitumCorp/eidetic` at commit `dfa7d1a` was not readable (GitHub returned not found). CID and Keycloak checks in `cloud/src/auth.mjs` follow the named contract (CID claim, RS256, issuer, audience, expiry, purpose). They are not a line-level copy of that commit.

## What this change adds

A local Drive service under `cloud/`:

- filesystem driver with tenant-scoped paths, atomic writes, and checksums
- the same storage interface implemented with AWS SDK v3 for a later S3-compatible endpoint
- SQLite by default, Postgres `cumulus` schema when `DATABASE_URL` is local
- upload, download, expiring signed share links, and delete
- persisted per-tenant quotas plus a project cap
- Keycloak JWT tenant isolation
- backup and restore of the database rows and ciphertext blobs
- `/healthz`, `/readyz`, and Prometheus text

The Supabase project Infinitum Corp (`ivqiskeziohbbtkcvlun`, eu-west-1, free plan) is recorded only as a future swap target. Migrations are not applied to it. Tests use SQLite and, for the S3 stub and Postgres path, local containers only.

## Still not operational

No host, disk volume, TLS certificate, running Keycloak, backup target, or on-call sink exists. `cloud/keycloak/cumulus-realm.json` is the realm definition for `id.cumuluscloud.app` and has not been imported. The free-plan pause, 1 GB cap, and 50 MB file cap are launch risks if the service is later pointed at that Supabase project. See `cloud/README.md`.
