# Deploy manifest

Free Cloudflare Workers in front of the existing free Supabase project. No Docker host, no R2, no KV, no D1, and no paid Supabase or Cloudflare add-on.

Nothing in this repository runs the commands below. CI does not deploy Drive, does not log in to Supabase, and does not call project `ivqiskeziohbbtkcvlun`. `.github/workflows/auto-deploy.yml` logs in to Cloudflare, but it publishes only `landing/`, not the `cumulus-cloud` Worker.

## Commit

Deploy one specific commit on `main`, chosen by its full SHA. Every job in `.github/workflows/cumulus-drive.yml` (`drive tests`, `live Keycloak and Drive`, `local Supabase Auth and Drive`, `cloudflare worker`) must be green on that exact SHA.

That workflow runs only when a push changes `cloud/**` or the workflow file. A `main` commit that changes neither has no `cumulus-drive` run and cannot be the deploy commit. Use the newest `main` commit whose `cumulus-drive` run is green on every job. Check it on the repository's Actions tab, filtered to the `cumulus-drive` workflow and branch `main`. A commit with no run counts as not green.

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

The Edge Function verifies the JWT, then reads `cumulus.identities.cid` for that `sub`. `cumulus.current_cid()` does the same lookup for row level security. Login does not touch the identities table. A failure there fails the Drive call only.

What the hook would affect if it were enabled is documented in `cloud/README.md`. Short version: it runs for every token this Auth project issues, and an exception rejects those logins.

## Supabase, in order

Use the SQL editor or the Supabase CLI against the free project only when a person is applying this manifest. Substitute the project ref on purpose. Do not export service-role keys into the repo.

If a custom access token hook is already enabled, turn it off before step 1. The migration drops that function. An enabled hook that calls a missing function rejects every login on the project.

1. **Migrations, in filename order.** Apply `cloud/supabase/migrations/20261107120000_cumulus.sql`, then `cloud/supabase/migrations/20261108120000_tenant_rls_and_bucket.sql`. The second file is required. It replaces `cumulus.current_cid()`, drops the hook function, revokes `INSERT`/`UPDATE`/`DELETE` on `cumulus.tenants` from `anon` and `authenticated`, and creates the bucket.

   After those migrations, add `cumulus` to the project's Exposed schemas (Settings → API). Keep any schemas already listed (`public`, `graphql_public`, and `eon` on this project). Equivalent SQL:

   ```sql
   alter role authenticator set pgrst.db_schemas = 'public, graphql_public, eon, cumulus';
   notify pgrst, 'reload config';
   ```

   Pin the same list in the dashboard so a later settings save does not drop `cumulus`. The Drive function sends `Accept-Profile: cumulus`; without this, PostgREST returns `PGRST106` (`Invalid schema: cumulus`) and authenticated Drive calls fail.

2. **Bucket.** Confirm `storage.buckets` has `id = cumulus-drive`, `public = false`, and `file_size_limit = 50000000`. Confirm `storage.objects` has no policy for `anon`, `authenticated`, or `public`. Do not add one. Blobs go through the S3 protocol as the service key, under `tenants/<tenantId>/<blobId>`.

3. **Hook.** In the Auth settings, the custom access token hook is disabled. The function from step 1's older migration is dropped by step 2. Leave it dropped.

4. **Identity rows.** For each Drive user, as `service_role` or the SQL editor (not as the user):

   - `insert into cumulus.identities (user_id, cid) values ('<auth user uuid>', '<cid>')`
   - `insert into cumulus.tenants (id, name, cid, max_bytes, max_objects, used_bytes, used_objects, created_at) values (...)`

   `authenticated` cannot insert or update those tenant rows, including `max_bytes` and `used_bytes`. The quota trigger updates `used_bytes` because it is `security definer`.

5. **Function.** From this commit:

   ```sh
   supabase functions deploy drive --project-ref ivqiskeziohbbtkcvlun --no-verify-jwt
   ```

   `--no-verify-jwt` matches `cloud/supabase/config.toml`. The function verifies the JWT itself.

6. **Function secrets, by name.** Set each with `supabase secrets set --project-ref ivqiskeziohbbtkcvlun`. Do not commit the values.

   | Name | What it is |
   | --- | --- |
   | `CUMULUS_REST_URL` | Project REST URL, no trailing slash. The function appends PostgREST paths. |
   | `CUMULUS_ANON_KEY` | Project anon key. Sent as `apikey` on user-scoped PostgREST calls. |
   | `CUMULUS_SERVICE_ROLE_KEY` | Service role key. Share downloads only. |
   | `CUMULUS_JWKS_URL` | `https://ivqiskeziohbbtkcvlun.supabase.co/auth/v1/.well-known/jwks.json` |
   | `CUMULUS_JWT_ISSUER` | `https://ivqiskeziohbbtkcvlun.supabase.co/auth/v1` |
   | `CUMULUS_S3_ENDPOINT` | Storage S3 endpoint for the project. |
   | `CUMULUS_S3_SIGN_HOST` | Host header the S3 signature must use, when it differs from the endpoint host. |
   | `CUMULUS_S3_ACCESS_KEY` | Storage S3 access key id. |
   | `CUMULUS_S3_SECRET_KEY` | Storage S3 secret. |
   | `CUMULUS_S3_REGION` | Storage S3 region. |
   | `CUMULUS_KMS_MASTER_KEY` | 32 bytes, base64. Not a Supabase key. |
   | `CUMULUS_SHARE_SECRET` | HMAC secret for share links. |
   | `CUMULUS_PUBLIC_BASE_URL` | `https://cloud.cumuluscloud.app` |

   Do not set `CUMULUS_ALLOW_SUPABASE` on the function. That variable is the local-process override and is not how this deploy is authorized.

## Worker build and deploy

`cloud/worker/wrangler.toml` is the only Wrangler config. It has no `account_id` and no KV, D1, or R2 bindings. `wrangler login` on the operator machine selects the account. Do not paste an account id into the file.

`SUPABASE_FUNCTION_URL` is a Worker secret, not a var in the toml:

```sh
cd cloud/worker
npx wrangler secret put SUPABASE_FUNCTION_URL
```

Value: `https://ivqiskeziohbbtkcvlun.supabase.co/functions/v1/drive`

Optional secrets, only to override the defaults: `CUMULUS_CLOUD_HOST`, `CUMULUS_ID_HOST`, `CUMULUS_MAIL_HOST`, `CUMULUS_CORS_ORIGINS`. The default allowlist is exactly `https://id.cumuluscloud.app`, `https://cloud.cumuluscloud.app`, and `https://mail.cumuluscloud.app`. A `*` value makes the proxy return 503.

Build the Vite client, then publish the Worker. The placeholder `cloud/worker/assets/index.html` is replaced by the client build. Do not deploy the placeholder as the console.

```sh
npm ci
npm run build
rm -rf cloud/worker/assets
mkdir -p cloud/worker/assets
cp -a dist/client/. cloud/worker/assets/
npx wrangler deploy --config cloud/worker/wrangler.toml
```

If `dist/client` is not where this Vite build wrote `index.html`, copy that client directory instead. `wrangler deploy` bundles `cloud/worker/src/index.mjs` and uploads `./assets`. There is no second Wrangler config.

The Worker serves those assets for console routes. It proxies `/api/*` on any host, and `/v1/*` plus `/healthz` when the host is `cloud.cumuluscloud.app`, to `SUPABASE_FUNCTION_URL`. It forwards `Authorization` and `x-cumulus-purpose` (and `x-cumulus-tenant`, `content-type`, `accept`). It strips hop-by-hop headers. An `Origin` outside the allowlist is 403 and is not proxied. A missing function URL is 503.

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
```

Expect `/api/healthz` to return `{"ok":true,"service":"cumulus-drive"}`. The allowlisted preflight returns 204 and `access-control-allow-origin: https://cloud.cumuluscloud.app`. The other origin returns 403 and no allow-origin header. `/` returns the console HTML.

Then, with a real user JWT whose `sub` is in `cumulus.identities`: upload, download, and a direct `POST` to `/storage/v1/object/cumulus-drive/...` with that same JWT. The Storage call must be denied. `GET /api/v1/usage` with `x-cumulus-purpose: drive.read` must succeed, and a `PATCH` of `cumulus.tenants.max_bytes` as that user must be denied.

## Rollback

1. Worker: `npx wrangler rollback --config cloud/worker/wrangler.toml` returns the previous Worker version, assets included. If this was the first version, delete the `cloud` DNS record instead so the hostname stops resolving.
2. DNS: remove the `cloud` CNAME, or point it at the previous origin. Leave `id` unpublished.
3. Function: redeploy the previous `cloud/supabase/functions/drive/index.ts` with the same `supabase functions deploy` command. Do not delete function secrets as part of a code rollback.
4. Database: do not drop `cumulus-drive` (that deletes blobs) and do not re-enable the access token hook. Restoring `authenticated` write access on `cumulus.tenants` is a forward SQL change, not a down migration, and it re-opens `max_bytes` and `used_bytes` to the user. Leave the revoke in place unless that is the explicit goal.
5. Confirm `/api/healthz` on the rolled-back Worker, or confirm the hostname no longer resolves.
