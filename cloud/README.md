# Cumulus Drive

Local storage service for Cumulus Drive. It is **not deployed** and it does **not** connect to the live Supabase project.

`cumuluscloud.app` is the canonical domain. DNS and email records are listed in `docs/cloudflare-dns-email.md`. That file does not call Cloudflare. Defaults:

| Variable | Default |
| --- | --- |
| `CUMULUS_ROOT_DOMAIN` | `cumuluscloud.app` |
| `CUMULUS_ID_HOST` | `id.cumuluscloud.app` |
| `CUMULUS_CLOUD_HOST` | `cloud.cumuluscloud.app` |
| `CUMULUS_MAIL_HOST` | `mail.cumuluscloud.app` |

The ID host is the Keycloak issuer (`https://id.cumuluscloud.app/realms/cumulus`), the default audience (`https://id.cumuluscloud.app`), and the JWKS URL under that issuer. `cloud/keycloak/cumulus-realm.json` is an import file for that realm (CID claim, purpose roles, PKCE clients for Cloud and Mail). It contains no users and no client secret, and it has not been imported. Share links use `https://cloud.cumuluscloud.app`. CORS allows exactly `https://` plus each of those three hosts. Override with `CUMULUS_CORS_ORIGINS` as a comma-separated list of origins. A `*` entry is rejected. Mail stays out of this service; only the hostname is recorded.

The primary driver stores ciphertext on the local filesystem (tenant-scoped paths, atomic writes, SHA-256 checksums). Metadata and quotas are in SQLite by default, or local Postgres when `DATABASE_URL` is set. An S3-compatible driver (`@aws-sdk/client-s3`) implements the same `put` / `get` / `delete` interface so R2, B2, S3, or Supabase Storage can be selected later with configuration. Tests exercise that driver only against a local SeaweedFS container (Apache-2.0). MinIO is AGPL and is not a dependency.

## Free-plan launch risks

The existing Supabase project **Infinitum Corp** (`ivqiskeziohbbtkcvlun`, eu-west-1, free plan) is the intended later swap target. This repository does not apply migrations there and does not call it.

If that swap happens, the free plan is a launch risk:

- **1 GB total storage.** Default project and tenant quotas are 1,000,000,000 bytes so they fit that cap. A second tenant shares the same project cap.
- **50 MB per file.** Uploads larger than 50,000,000 bytes are rejected.
- **The project pauses when inactive.** A paused free project refuses uploads and downloads until someone restores it in the Supabase dashboard. This service cannot keep the project awake, and it does not send traffic there.

Other free-plan limits (database size, egress, request rate) were not verified and are not enforced here.

## Run tests

```sh
cd cloud
npm ci
npm test
```

`npm test` starts local Postgres and SeaweedFS with `cloud/deploy/docker-compose.yml` for the container tests. The filesystem and SQLite tests do not need those containers, but the S3 stub test does.

## Environment for a future host

Do not point these at the live project unless that swap has been explicitly approved.

- `CUMULUS_STORAGE_DRIVER` — `filesystem` (default) or `s3`
- `CUMULUS_DATA_DIR` — SQLite file and blob directory
- `DATABASE_URL` — local Postgres; migrations live in `migrations/001_cumulus_drive.sql` (`cumulus` schema)
- `CUMULUS_S3_ENDPOINT`, `CUMULUS_S3_BUCKET`, `CUMULUS_S3_REGION`, `CUMULUS_S3_ACCESS_KEY`, `CUMULUS_S3_SECRET_KEY`
- `CUMULUS_KMS_MASTER_KEY` — 32 bytes, base64 or hex; not stored in backups
- `CUMULUS_BOOTSTRAP_TOKEN` — creates tenants
- `CUMULUS_SHARE_SECRET` — HMAC for expiring share links (1–900 seconds)
- `CUMULUS_ROOT_DOMAIN`, `CUMULUS_ID_HOST`, `CUMULUS_CLOUD_HOST`, `CUMULUS_MAIL_HOST`
- `CUMULUS_KEYCLOAK_ISSUER`, `CUMULUS_KEYCLOAK_AUDIENCE`, `CUMULUS_KEYCLOAK_JWKS_URL` (optional; derived from the ID host)
- `CUMULUS_PUBLIC_BASE_URL` (optional; derived from the cloud host)
- `CUMULUS_CORS_ORIGINS` (optional exact origins; no wildcard)

A CID string is not a credential. Callers need a Keycloak RS256 JWT whose `cid` claim is bound to a tenant, plus `x-cumulus-purpose` (`drive.read`, `drive.write`, or `drive.share`).

The live Supabase hostname and project ref are refused unless `CUMULUS_ALLOW_SUPABASE=I-understand-this-touches-prod`. That variable is not set anywhere in this repository.
