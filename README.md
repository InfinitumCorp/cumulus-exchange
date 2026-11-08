# Cumulus://Cloud

One product. Cumulus://Cloud is Cumulus Drive. The Exchange is Cumulus://Cloud.

Opt-in datasets, explicit consent, an 85% owner share, and one soulbound CDAT license per sale. The ledger in this app is a local preview of Firmament. Military editions and government workloads stay off the product.

Signed in for the demo as `alex@cumuluscloud.app`.

`cumuluscloud.app` is the canonical domain, hosted at Cloudflare, for Cumulus://ID, Cumulus://Cloud, and Cumulus://Mail. Defaults are `id.cumuluscloud.app`, `cloud.cumuluscloud.app`, and `mail.cumuluscloud.app`. See `.env.example`. This repository does not change DNS.

Drive storage code lives in `cloud/` and is not deployed by CI. The primary store is a local filesystem. Keycloak remains the default auth mode. The free launch path is a Cloudflare Worker in front of the Supabase Edge Function, which resolves `cid` from `cumulus.identities` and does not use a project-wide Auth hook. A later swap onto the Infinitum Corp Supabase free project would be capped at 1 GB total and 50 MB per file, and that project pauses when inactive. Those are launch risks. This repo does not connect to the live project and does not apply migrations there. The operator checklist is `cloud/DEPLOY.md`.

```sh
npm install
npm run dev
```
