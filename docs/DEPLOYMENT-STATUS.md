# Deployment status — 2026-11-07

Target: Cloudflare Workers and the existing Infinitum Corp Supabase project
`ivqiskeziohbbtkcvlun` (eu-west-1).

## Applied to Supabase

Migration `20261107181308_cumulus_drive_private_storage` created the existing
Drive metadata schema (`cumulus.tenants`, `objects`, `shares`), enabled RLS,
and revoked browser-role access. No tenant or customer records were inserted.
The private `cumulus-drive` storage bucket has a 50,000,000-byte file limit.
The migration is checked in under `supabase/migrations/`.

## Prepared and checked locally

`CUMULUS_DEPLOY_TARGET=cloudflare npm run build` selects Nitro's Cloudflare
module output while retaining the existing default build. The generated Worker
configuration is `.output/server/wrangler.json`. The root `wrangler.jsonc`
combines the frontend with the Drive Fetch handler. Use `npm run build:cloudflare`
then Wrangler 4.158.0 with `deploy --config wrangler.jsonc`. A dry-run bundle
passed (487 KB gzip), and the combined Worker runs in Wrangler's local runtime.

The Drive backend now supports `CUMULUS_STORAGE_DRIVER=supabase`. Configure
`CUMULUS_SUPABASE_URL`, `CUMULUS_SUPABASE_SECRET_KEY`, and optionally
`CUMULUS_SUPABASE_BUCKET`. The secret is server-only. The explicit live-project
guard still requires `CUMULUS_ALLOW_SUPABASE=I-understand-this-touches-prod`.
The adapter stores the existing encrypted blobs, not plaintext files.

## Remaining before launch

- Authorize Cloudflare. The initial Wrangler check was unauthenticated. The
  official Cloudflare MCP server is registered and its OAuth flow was started.
- Set Worker secrets `DATABASE_URL`, `CUMULUS_KMS_MASTER_KEY`,
  `CUMULUS_BOOTSTRAP_TOKEN`, `CUMULUS_SHARE_SECRET`, and
  `CUMULUS_SUPABASE_SECRET_KEY`. Use the Supabase Postgres pooler connection
  string. The Worker uses request-scoped connections and a database advisory
  transaction lock for shared quotas. Migrations run separately, never on requests.
  The Worker caps files at 10 MB because existing encryption buffers bytes;
  the Node service retains its 50 MB cap. Verify a real storage round trip.
- Provision the Cumulus ID issuer and connect the frontend to authenticated
  Drive operations. The current frontend remains the browser-local Exchange demo.
- Deploy frontend assets and configure DNS only after their origins work.
- Complete backups, restore testing, and monitoring for the production data path.

## Verification limits

Both repositories' frontend production builds and TypeScript checks passed.
Thirteen non-container Drive tests passed, including binary upload/download,
JWT verification, tenant isolation, deletes, CORS, and missing-secret handling
through the Fetch bridge. The local Worker health route responds and the data
API refuses missing configuration with HTTP 503.
Mail's complete test command passed. Exchange's complete test command stops on
missing `.grok/skills/og/references` template assets in the repository.
Browser smoke checks render content but report an external resource certificate
error in this environment. No end-to-end production deployment is claimed.
