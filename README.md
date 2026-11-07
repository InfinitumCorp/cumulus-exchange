# Cumulus://Cloud

One product. Cumulus://Cloud is Cumulus Drive. The Exchange is Cumulus://Cloud.

Opt-in datasets, explicit consent, an 85% owner share, and one soulbound CDAT license per sale. The ledger in this app is a local preview of Firmament. Military editions and government workloads stay off the product.

Signed in for the demo as `alex@cumuluscloud.app`.

`cumuluscloud.app` is the canonical domain, hosted at Cloudflare, for Cumulus://ID, Cumulus://Cloud, and Cumulus://Mail. Defaults are `id.cumuluscloud.app`, `cloud.cumuluscloud.app`, and `mail.cumuluscloud.app`. See `.env.example`. This repository does not change DNS.

Drive storage code lives in `cloud/` and is not deployed. The primary store is a local filesystem. A later swap onto the Infinitum Corp Supabase free project would be capped at 1 GB total and 50 MB per file, and that project pauses when inactive. Those are launch risks; this repo does not connect to the live project.

The console lists datasets on a Leaflet map, takes a per-scope opt-in that can be revoked, and runs license offer, accept, and revoke with an integer 85/15 split. CDAT rows are soulbound. The Firmament view is a local preview ledger. Drive upload, download, share, and delete call `/api/drive`, which the dev server mounts only when `cloud/src/dev-preview.mjs` is present. No card payment runs here.

Infinitum Corporation®. Civilian and business cyber workloads only.

```sh
npm install
npm run dev
```
