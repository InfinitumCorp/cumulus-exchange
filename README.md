# Cumulus://Cloud

One product. Cumulus://Cloud is Cumulus Drive. The Exchange is Cumulus://Cloud.

Opt-in datasets, explicit consent, an 85% owner share, and one soulbound CDAT license per sale. The ledger in this app is a local preview of Firmament. Military editions and government workloads stay off the product.

Signed in for the demo as `alex@cumuluscloud.app`.

`cumuluscloud.app` is the canonical domain, hosted at Cloudflare, for Cumulus://ID, Cumulus://Cloud, and Cumulus://Mail. Defaults are `id.cumuluscloud.app`, `cloud.cumuluscloud.app`, and `mail.cumuluscloud.app`. See `.env.example`. This repository does not change DNS.

Drive storage code lives in `cloud/` and is not deployed by CI. The primary store is a local filesystem. People sign in with Cumulus://ID (OIDC issuer `https://id.cumuluscloud.app/realms/cumulus`, overridable with `CID_ISSUER`): the app shows "Sign in with Cumulus ID" and "Create a Cumulus ID" (`prompt=create`), runs authorization code + PKCE S256 + nonce as a public client (`cumulus-cloud`, or `cumulus-exchange` when `BETTER_AUTH_URL` is `https://exchange.cumuluscloud.app`; `CID_CLIENT_ID` overrides), verifies the ID token against the issuer's JWKS (signature, `iss`, `aud`, `exp`, `nonce`) and keys the user by `sub`. There is no local password. The `cloud/` Drive process verifies Cumulus://ID access tokens by default (`CUMULUS_AUTH_MODE=cid`): ES256 `at+jwt` against the JWKS, `aud` in `CID_AUDIENCES`, the verified `sub` is the tenant, and `/userinfo` confirms the session is still live; Keycloak is an opt-in mode. The free launch path is a Cloudflare Worker in front of the Supabase Edge Function, which resolves `cid` from `cumulus.identities` and does not use a project-wide Auth hook. A later swap onto the Infinitum Corp Supabase free project would be capped at 1 GB total and 50 MB per file, and that project pauses when inactive. Those are launch risks. This repo does not connect to the live project and does not apply migrations there. The operator checklist is `cloud/DEPLOY.md`.

The console lists datasets on a Leaflet map, takes a per-scope opt-in that can be revoked, and runs license offer, accept, and revoke with an integer 85/15 split. CDAT rows are soulbound. The Firmament view is a local preview ledger. When `cloud/src/dev-preview.mjs` is present, Drive upload, download, share, and delete call `/api/drive`. Otherwise the Store screen uses this app's Better Auth session, a local byte directory, and file-backed PGLite (`docs/drive-storage.md`). That session store does not replace `cloud/` or Supabase mode. The address `demo.alex@cumuluscloud.app` is a browser label, not an account and not a mailbox. No card payment runs here.

Infinitum Corporation®. Civilian and business cyber workloads only.

```sh
npm install
npm run dev
```
