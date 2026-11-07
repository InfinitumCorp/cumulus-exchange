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
configuration is `.output/server/wrangler.json`. Wrangler 4.158.0 can serve this
output locally or deploy it using `wrangler deploy --config .output/server/wrangler.json`.

The Drive backend now supports `CUMULUS_STORAGE_DRIVER=supabase`. Configure
`CUMULUS_SUPABASE_URL`, `CUMULUS_SUPABASE_SECRET_KEY`, and optionally
`CUMULUS_SUPABASE_BUCKET`. The secret is server-only. The explicit live-project
guard still requires `CUMULUS_ALLOW_SUPABASE=I-understand-this-touches-prod`.
The adapter stores the existing encrypted blobs, not plaintext files.

## Remaining before launch

- Authorize Cloudflare. The initial Wrangler check was unauthenticated. The
  official Cloudflare MCP server is registered and its OAuth flow was started.
- Deploy the Drive backend on a compatible runtime, configure its Postgres
  connection and encryption/signing secrets, and perform a real storage round trip.
  Adding a Cloudflare frontend target does not port the Node Drive service to Workers.
- Provision the Cumulus ID issuer and connect the frontend to authenticated
  Drive operations. The current frontend remains the browser-local Exchange demo.
- Deploy frontend assets and configure DNS only after their origins work.
- Complete backups, restore testing, and monitoring for the production data path.

## Verification limits

Both repositories' frontend production builds and TypeScript checks passed.
Nine existing non-container Drive tests and two new storage adapter tests passed.
Mail's complete test command passed. Exchange's complete test command stops on
missing `.grok/skills/og/references` template assets in the repository.
Browser smoke checks render content but report an external resource certificate
error in this environment. No end-to-end production deployment is claimed.
