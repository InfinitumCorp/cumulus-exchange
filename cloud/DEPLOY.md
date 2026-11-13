# Deploy manifest

Free Cloudflare Workers in front of the existing free Supabase project. No Docker host, no R2, no KV, no D1, and no paid Supabase or Cloudflare add-on.

Nothing in this repository runs the commands below. CI does not deploy Drive, does not log in to Supabase, and does not call project `ivqiskeziohbbtkcvlun`. `.github/workflows/auto-deploy.yml` logs in to Cloudflare, but it publishes only `landing/`, not the `cumulus-cloud` Worker.

## Commit

Deploy one specific commit on `main`, chosen by its full SHA. The deploy ships both the console (the Worker) and the Drive Edge Function, so every check that ran on that exact SHA must be green:

- `.github/workflows/console.yml` (`lint, typecheck, test, build`, which also builds the Worker and runs `wrangler deploy --dry-run`) runs when a push changes anything outside `cloud/**`.
- `.github/workflows/cumulus-drive.yml` (`drive tests`, `live Keycloak and Drive`, `local Supabase Auth and Drive`, `cloudflare worker`) runs when a push changes `cloud/**` or that workflow file.

Because of those path filters, a commit can have runs from one workflow, the other, or both. Use the newest `main` commit where every run is green, checked on the commit's checks list on GitHub. A commit with no runs at all counts as not green.

Do not deploy a feature branch, including `cursor/cumulus-supabase-mode-172a`. That branch was squash-merged into `main` and is stale. It lacks later work on `main` that this deploy ships: the fix that lets the hosted function boot without `CUMULUS_ALLOW_SUPABASE`, the Worker placement in `cloud/worker/wrangler.toml`, and the console's Cumulus ID sign-in in the client build. Its history also contains `168808a`.

Do not deploy `168808a93cafd2b299a9954186edefe832a6d23a`. That commit still installs the project-wide access token hook and still grants `authenticated` write access to `cumulus.tenants`.

```sh
DEPLOY_SHA=<full SHA of the green main commit>
git fetch origin main
git merge-base --is-ancestor "$DEPLOY_SHA" origin/main && echo "on main"
git checkout --detach "$DEPLOY_SHA"
git rev-parse HEAD
```

Stop if `on main` is not printed. The printed SHA is the deploy commit. Build the Worker and the function from that tree. Record the SHA with the deploy so the rollback steps below have a known previous version.

## Hook decision

The project-wide custom access token hook stays **off**. Do not enable Authentication → Hooks → Custom Access Token hook. Do not recreate `public.custom_access_token_hook`.

The Edge Function authenticates Drive calls itself, and the default is Cumulus ID (`CUMULUS_AUTH_MODE=cid`). It checks the Cumulus ID access token against the issuer's JWKS (ES256, `typ: at+jwt`, `iss`, `aud` in `CID_AUDIENCES`, `exp`), then asks the issuer's `/userinfo` that the session is live and names the same `sub`. The verified `sub` is the cid. PostgREST does not accept Cumulus ID tokens, so in this mode the function reads and writes `cumulus` metadata as `service_role` and filters every query by the tenant row whose `cid` matches. Row level security does not apply to those calls; the function's own checks are the boundary. The quota trigger still runs.

`CUMULUS_AUTH_MODE=supabase` is the older opt-in mode. The function then verifies a Supabase Auth JWT, reads `cumulus.identities.cid` for that `sub`, and calls PostgREST as the user so row level security applies. `cumulus.current_cid()` does the same lookup. Either way, login does not touch the identities table, and a failure there fails the Drive call only.

What the hook would affect if it were enabled is documented in `cloud/README.md`. Short version: it runs for every token this Auth project issues, and an exception rejects those logins.

## Supabase, in order

Use the SQL editor or the Supabase CLI against the free project only when a person is applying this manifest. Substitute the project ref on purpose. Do not export service-role keys into the repo.

If a custom access token hook is already enabled, turn it off before step 1. The migration drops that function. An enabled hook that calls a missing function rejects every login on the project.

1. **Migrations, in filename order.** Apply `cloud/supabase/migrations/20261107120000_cumulus.sql`, then `cloud/supabase/migrations/20261108120000_tenant_rls_and_bucket.sql`. The second file is required. It replaces `cumulus.current_cid()`, drops the hook function, revokes `INSERT`/`UPDATE`/`DELETE` on `cumulus.tenants` from `anon` and `authenticated`, and creates the bucket. Then `cloud/supabase/migrations/20261113210000_drive_parity.sql`: additive columns on `cumulus.objects` (`starred`, `trashed_at`, `preview_class`, `sealed_name`) and the `cumulus.activity` table, with row level security like the other tables. The console's star, trash, restore, photos and activity views need it.

   After those migrations, add `cumulus` to the project's Exposed schemas (Settings → API). Keep any schemas already listed (`public`, `graphql_public`, and `eon` on this project). Equivalent SQL:

   ```sql
   alter role authenticator set pgrst.db_schemas = 'public, graphql_public, eon, cumulus';
   notify pgrst, 'reload config';
   ```

   Pin the same list in the dashboard so a later settings save does not drop `cumulus`. The Drive function sends `Accept-Profile: cumulus`; without this, PostgREST returns `PGRST106` (`Invalid schema: cumulus`) and authenticated Drive calls fail.

2. **Bucket.** Confirm `storage.buckets` has `id = cumulus-drive`, `public = false`, and `file_size_limit = 50000000`. Confirm `storage.objects` has no policy for `anon`, `authenticated`, or `public`. Do not add one. Blobs go through the S3 protocol as the service key, under `tenants/<tenantId>/<blobId>`.

3. **Hook.** In the Auth settings, the custom access token hook is disabled. The function from step 1's older migration is dropped by step 2. Leave it dropped.

4. **Tenant rows.** With `CUMULUS_AUTH_MODE=cid` (the default) there is nothing to insert. The first Drive call from a verified Cumulus ID creates its `cumulus.tenants` row as `service_role`: `name` and `cid` are the person's Cumulus ID subject (`cid_<uuid>`), with the free quota `CUMULUS_FREE_MAX_BYTES` (default 104857600, 100 MiB, the same as the console's session-store Drive) and `CUMULUS_FREE_MAX_OBJECTS` (default 10000). A paid plan raises `max_bytes` on that row, as `service_role` or in the SQL editor.

   Only with `CUMULUS_AUTH_MODE=supabase`, insert both rows by hand, as `service_role` or in the SQL editor (not as the user):

   - `insert into cumulus.tenants (id, name, cid, max_bytes, max_objects, used_bytes, used_objects, created_at) values (...)`
   - `insert into cumulus.identities (user_id, cid) values ('<auth user uuid>', '<cid>')`

   `authenticated` cannot insert or update tenant rows, including `max_bytes` and `used_bytes`. The quota trigger updates `used_bytes` because it is `security definer`.

5. **Function.** From this commit:

   ```sh
   supabase functions deploy drive --project-ref ivqiskeziohbbtkcvlun --no-verify-jwt
   ```

   `--no-verify-jwt` matches `cloud/supabase/config.toml`. The function verifies the JWT itself.

6. **Function secrets, by name.** Set each with `supabase secrets set --project-ref ivqiskeziohbbtkcvlun`. Do not commit the values.

   | Name | What it is |
   | --- | --- |
   | `CUMULUS_REST_URL` | Project REST URL, no trailing slash. The function appends PostgREST paths. |
   | `CUMULUS_SERVICE_ROLE_KEY` | Service role key. Every metadata call in `cid` mode, and share downloads in both modes. |
   | `CUMULUS_AUTH_MODE` | Optional. `cid` (default) or `supabase`. Any other value stops the function at boot. |
   | `CID_ISSUER` | Optional. Defaults to `https://id.cumuluscloud.app/realms/cumulus`. |
   | `CID_AUDIENCES` | Optional. Comma-separated client ids whose access tokens Drive accepts. Defaults to `cumulus-cloud,cumulus-exchange,cumulus-mail`. |
   | `CID_JWKS_URL` | Optional. Defaults to `<CID_ISSUER>/protocol/openid-connect/certs`. |
   | `CUMULUS_ANON_KEY` | `supabase` mode only. Project anon key, sent as `apikey` on user-scoped PostgREST calls. |
   | `CUMULUS_JWKS_URL` | `supabase` mode only. `https://ivqiskeziohbbtkcvlun.supabase.co/auth/v1/.well-known/jwks.json` |
   | `CUMULUS_JWT_ISSUER` | `supabase` mode only. `https://ivqiskeziohbbtkcvlun.supabase.co/auth/v1` |
   | `CUMULUS_S3_ENDPOINT` | Storage S3 endpoint for the project. |
   | `CUMULUS_S3_SIGN_HOST` | Host header the S3 signature must use, when it differs from the endpoint host. |
   | `CUMULUS_S3_ACCESS_KEY` | Storage S3 access key id. |
   | `CUMULUS_S3_SECRET_KEY` | Storage S3 secret. |
   | `CUMULUS_S3_REGION` | Storage S3 region. |
   | `CUMULUS_KMS_MASTER_KEY` | 32 bytes, base64. Not a Supabase key. |
   | `CUMULUS_SHARE_SECRET` | HMAC secret for share links. |
   | `CUMULUS_PUBLIC_BASE_URL` | `https://cloud.cumuluscloud.app` |
   | `CUMULUS_FREE_MAX_BYTES` | Optional. Quota of a tenant created on first use. Default 104857600 (100 MiB). |
   | `CUMULUS_FREE_MAX_OBJECTS` | Optional. Object cap of a tenant created on first use. Default 10000. |

   Do not set `CUMULUS_ALLOW_SUPABASE` on the function. That variable is the local-process override and is not how this deploy is authorized.

## Worker build and deploy

The `cumulus-cloud` Worker is the whole console: the TanStack Start server built by Nitro for Cloudflare (`NITRO_PRESET=cloudflare-module`), with its browser files as Worker assets. It serves the console pages, runs "Sign in with Cumulus ID" (Better Auth at `/api/auth/*`), and keeps sessions in the Supabase project's Postgres. Only Drive API calls go to the Edge Function: `/api/drive/v1/*` and `/api/healthz` on any host, and `/v1/*` plus `/healthz` on `cloud.cumuluscloud.app` (share links). Everything stays on the free Workers and Supabase plans; the compressed upload is about 1.4 MB, under the free plan's 3 MB Worker limit.

`cloud/worker/wrangler.toml` is the only Wrangler config. It has no `account_id` and no KV, D1, or R2 bindings. `wrangler login` on the operator machine selects the account. Do not paste an account id into the file. It uploads the Nitro output in `.output/` as built (`no_bundle`), so always build first.

1. **Console database.** The console's own tables (Better Auth `user`, `session`, `account`, `verification`, and the session-store Drive tables) go in the same Supabase project, schema `public`. From the deploy commit, with the project's Postgres connection string:

   ```sh
   DATABASE_URL='<transaction pooler URL, port 6543>' npm run db:migrate
   ```

   Use Supabase's transaction pooler (Settings → Database → Connection string → Transaction, port 6543). On Workers every query opens its own connection (`src/lib/pg-pool.ts`), and the pooler keeps those cheap. `migrations/0004_console_rls.sql` turns on row level security with no policies for every console table, so `anon` and `authenticated` cannot read sessions or tokens through the Data API. The console connects as the owner and is not affected. Do not add policies to those tables.

2. **Worker secrets, by name.** Set each with `npx wrangler secret put <NAME> --config cloud/worker/wrangler.toml`. Do not commit the values.

   | Name | What it is |
   | --- | --- |
   | `DATABASE_URL` | The same transaction pooler URL as step 1. |
   | `BETTER_AUTH_SECRET` | Random, at least 32 characters (`openssl rand -base64 48`). Signs session cookies and encrypts stored Cumulus ID tokens. Changing it signs everyone out. |
   | `BETTER_AUTH_URL` | `https://cloud.cumuluscloud.app`. The sign-in callback is `<this>/api/auth/callback/cumulus-id`. |
   | `VITE_AUTH_ENABLED` | `true` |
   | `SUPABASE_FUNCTION_URL` | `https://ivqiskeziohbbtkcvlun.supabase.co/functions/v1/drive` |

   Optional, only to override the defaults: `CID_ISSUER`, `CID_CLIENT_ID`, `CUMULUS_CLOUD_HOST`, `CUMULUS_ID_HOST`, `CUMULUS_MAIL_HOST`, `CUMULUS_CORS_ORIGINS`. The default Drive CORS allowlist is exactly `https://id.cumuluscloud.app`, `https://cloud.cumuluscloud.app`, and `https://mail.cumuluscloud.app`. A `*` value makes the proxy return 503.

   Cumulus ID must list `https://cloud.cumuluscloud.app/api/auth/callback/cumulus-id` and `.../callback/cumulus-id-create` as redirect URIs for the `cumulus-cloud` client (cumulus-id `src/clients.ts`). Sign-in fails with a redirect error until it does.

3. **Build and deploy.**

   ```sh
   npm ci
   NITRO_PRESET=cloudflare-module npx vite build
   npx wrangler deploy --dry-run --config cloud/worker/wrangler.toml
   npx wrangler deploy --config cloud/worker/wrangler.toml
   ```

   Build with `npx vite build`, not `npm run build`: the npm script also runs `db:migrate`, which belongs to step 1 and needs `DATABASE_URL` in the shell. The build also writes `.output/server/wrangler.json` and `.wrangler/deploy/config.json` with a generated Worker name. Ignore them; pass `--config cloud/worker/wrangler.toml` every time so the Worker stays `cumulus-cloud`.

The cloud Drive view gets its bearer from `GET /api/drive/cid-token`: the signed-in person's Cumulus ID access token, which Better Auth stored encrypted at sign-in and refreshes when it has expired. The Edge Function verifies that token (`CUMULUS_AUTH_MODE=cid`). The proxy forwards `Authorization` and `x-cumulus-purpose` (and `x-cumulus-tenant`, `content-type`, `accept`). It strips hop-by-hop headers. An `Origin` outside the allowlist is 403 and is not proxied. A missing function URL is 503.

`cloud/worker/assets/` and the static-assets mode of `cloud/worker/src/index.mjs` (`handleRequest`) are kept for the proxy's tests. They are not deployed.

## DNS

Zone `cumuluscloud.app` is already on Cloudflare. These records are a dashboard step. This repo does not call the Cloudflare API.

| Name | Record | Target | Proxy |
| --- | --- | --- | --- |
| `cloud.cumuluscloud.app` | CNAME `cloud` | The workers.dev hostname `wrangler deploy` prints for `cumulus-cloud`, or a Workers custom domain attached to that Worker | Proxied. Universal SSL on the free plan. |
| `id.cumuluscloud.app` | Leave unpublished for this free launch | Auth stays at `https://ivqiskeziohbbtkcvlun.supabase.co/auth/v1` | Do not CNAME `id` at `ivqiskeziohbbtkcvlun.supabase.co`. Supabase custom domains are paid, and that CNAME fails TLS without one. Keycloak, if it is stood up later, is the origin for this name. |

`cloud` is the Worker. `id` is not the Worker. Share links use `https://cloud.cumuluscloud.app`.

SSL/TLS → Full. Minimum TLS 1.2. Always Use HTTPS, once `cloud` is proxied.

## Smoke test

Run this after DNS answers and the function secrets are set. Do not run it from CI.

```sh
curl -fsS "https://cloud.cumuluscloud.app/api/healthz"
curl -fsS -D - -o /dev/null -X OPTIONS "https://cloud.cumuluscloud.app/api/healthz" \
  -H "origin: https://cloud.cumuluscloud.app" \
  -H "access-control-request-method: GET"
curl -sS -D - -o /dev/null -X OPTIONS "https://cloud.cumuluscloud.app/api/healthz" \
  -H "origin: https://evil.example" \
  -H "access-control-request-method: GET"
curl -fsS -D - -o /dev/null "https://cloud.cumuluscloud.app/"
curl -fsS "https://cloud.cumuluscloud.app/api/auth/get-session"
curl -sS -o /dev/null -w '%{http_code}\n' "https://cloud.cumuluscloud.app/api/drive/cid-token"
```

Expect `/api/healthz` to return `{"ok":true,"service":"cumulus-drive"}`. The allowlisted preflight returns 204 and `access-control-allow-origin: https://cloud.cumuluscloud.app`. The other origin returns 403 and no allow-origin header. `/` returns the console HTML. `/api/auth/get-session` returns `null` (no session yet, and no 500). `/api/drive/cid-token` returns 401 until someone signs in.

Then sign in at `https://cloud.cumuluscloud.app/login` with Cumulus ID and open Drive. The Drive view should list files and show usage; `GET /api/drive/cid-token` in that browser returns a token whose `aud` is `cumulus-cloud`.

Then, with a real Cumulus ID access token whose cid has a tenant row (or, in `supabase` mode, a Supabase user JWT whose `sub` is in `cumulus.identities`): list, upload, download, and a direct `POST` to `/storage/v1/object/cumulus-drive/...` with that same token. The Storage call must be denied. `GET /api/drive/v1/usage` with `x-cumulus-purpose: drive.read` must succeed, and a `PATCH` of `cumulus.tenants.max_bytes` as that user must be denied.

## Rollback

1. Worker: `npx wrangler rollback --config cloud/worker/wrangler.toml` returns the previous Worker version, assets included. If this was the first version, delete the `cloud` DNS record instead so the hostname stops resolving.
2. DNS: remove the `cloud` CNAME, or point it at the previous origin. Leave `id` unpublished.
3. Function: redeploy the previous `cloud/supabase/functions/drive/index.ts` with the same `supabase functions deploy` command. Do not delete function secrets as part of a code rollback.
4. Database: do not drop `cumulus-drive` (that deletes blobs) and do not re-enable the access token hook. Restoring `authenticated` write access on `cumulus.tenants` is a forward SQL change, not a down migration, and it re-opens `max_bytes` and `used_bytes` to the user. Leave the revoke in place unless that is the explicit goal.
5. Confirm `/api/healthz` on the rolled-back Worker, or confirm the hostname no longer resolves.
