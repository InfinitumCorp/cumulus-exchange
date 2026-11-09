# Cumulus Drive

Local storage service for Cumulus Drive. It is **not deployed** and it does **not** connect to the live Supabase project.

`cumuluscloud.app` is the canonical domain. DNS and email records are listed in `docs/cloudflare-dns-email.md`. That file does not call Cloudflare. Defaults:

| Variable | Default |
| --- | --- |
| `CUMULUS_ROOT_DOMAIN` | `cumuluscloud.app` |
| `CUMULUS_ID_HOST` | `id.cumuluscloud.app` |
| `CUMULUS_CLOUD_HOST` | `cloud.cumuluscloud.app` |
| `CUMULUS_MAIL_HOST` | `mail.cumuluscloud.app` |

The ID host is the Keycloak issuer (`https://id.cumuluscloud.app/realms/cumulus`), the default audience (`https://id.cumuluscloud.app`), and the JWKS URL under that issuer. Share links use `https://cloud.cumuluscloud.app`. CORS allows exactly `https://` plus each of those three hosts. Override with `CUMULUS_CORS_ORIGINS` as a comma-separated list of origins. A `*` entry is rejected. Mail stays out of this service; only the hostname is recorded.

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

`cloud/deploy/docker-compose.stack.yml` starts a real Keycloak (realm `cumulus`), Postgres, and the Drive process. CI runs `test/e2e-stack.test.mjs` against that stack with `CUMULUS_E2E=1`. Those tests log in through Keycloak with PKCE. They do not use a demo session. The stack is local only and is not a deploy.

## Supabase mode (local CLI only)

`CUMULUS_AUTH_MODE=supabase` on the Node process keeps Keycloak as the default and adds a second verifier. That Node verifier still reads `cid` from `app_metadata.cid`. It is not the free launch path. The live project ref is still refused.

The free path is the Edge Function in `cloud/supabase/functions/drive` behind the Worker in `cloud/worker`. The function checks Supabase Auth JWTs against the project JWKS (`ES256` or `RS256`) and loads `cid` from `cumulus.identities` where `user_id` is the verified `sub`. It does not read a cid claim from the token.

Metadata lives in schema `cumulus` under `cloud/supabase/migrations`. Every table has row level security. `cumulus.tenants` is `SELECT` only for `authenticated`. `max_bytes` and `used_bytes` change only as `service_role`, or inside `cumulus.enforce_object_quota()`, which is `security definer` and runs as its owner. The Edge Function calls PostgREST with the user's Supabase JWT, so PostgREST sets the `authenticated` role and `request.jwt.claims` and the policies apply. `cumulus.current_cid()` resolves the same identity row from `sub`. The quota trigger enforces the tenant cap and the 50 MB file cap for that role. A share download checks the HMAC first, then reads through the service role.

Storage uses the private bucket `cumulus-drive` (not public, 50 MB file limit) through Supabase Storage's S3 endpoint. Migration `20261108120000_tenant_rls_and_bucket.sql` creates that bucket and does not add `anon` or `authenticated` policies on `storage.objects`. A direct Storage REST call with a user JWT is denied. Object keys are `tenants/<tenantId>/<blobId>`, the same layout as the Node S3 driver. The local end-to-end test probes that driver against the CLI's S3 endpoint, then exercises the Drive API at `cloud/supabase/functions/drive`. CI runs `sh scripts/supabase-e2e.sh`, which starts that stack, resets only the local database, and covers login, upload, download, share, quota, delete, tenant isolation, denied tenant writes, and denied direct Storage access. It does not link or deploy project `ivqiskeziohbbtkcvlun`.

The Worker serves the Vite console as static assets and proxies `/api/*` on any host, plus `/v1/*` and `/healthz` on `cloud.cumuluscloud.app`, to `SUPABASE_FUNCTION_URL`. `cloud/worker/wrangler.toml` has no account id and no KV, D1, or R2. Deploy steps are in `cloud/DEPLOY.md`.

DNS for `id.cumuluscloud.app` and `cloud.cumuluscloud.app` is in `docs/cloudflare-dns-email.md`. Supabase custom domains are not required.

## Custom access token hook

**The project-wide hook is removed.** `cloud/supabase/config.toml` does not enable `[auth.hook.custom_access_token]`. The migration drops `public.custom_access_token_hook`. Do not create it again on the free project.

What that hook would affect if it were turned back on:

- Supabase Auth runs it for every access token the project issues: password login, refresh, signup, OAuth, and magic link. That is every user of the project, including people who never call Drive.
- The old function read `cumulus.identities` and wrote `app_metadata.cid` into the token. Row level security used to trust that claim.
- An exception in the hook fails token issuance. A missing grant, a broken `cumulus.identities` table, or a bad cast would reject logins for the whole project. The hook does not see `x-cumulus-purpose`. It does not grant Storage access. It only rewrites claims, so a bad rewrite can attach the wrong tenant or none.
- Auth would depend on Drive's identity table. Drive would then depend on Auth having succeeded. A fault in either direction takes both down.

With the hook off, login does not touch `cumulus.identities`. The Edge Function and `cumulus.current_cid()` read that table after the JWT is verified. A broken identity row fails the Drive request and fails closed. It does not fail Auth. A cid stuffed into the token is ignored.

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

A CID string is not a credential. Callers need a JWT bound to a tenant, plus `x-cumulus-purpose` (`drive.read`, `drive.write`, or `drive.share`). Keycloak mode requires an RS256 token whose `cid` claim is present. The Edge Function requires an Auth token whose `sub` has a row in `cumulus.identities`. The Node Supabase verifier, which is not the Worker path, still requires `app_metadata.cid`.

The live Supabase hostname and project ref are refused unless `CUMULUS_ALLOW_SUPABASE=I-understand-this-touches-prod`. That variable is not set anywhere in this repository.
