# cumuluscloud.app DNS and email

Documentation only. Nothing in this repository creates DNS records, calls the Cloudflare API, or sends mail. `cumuluscloud.app` is already registered and is hosted on Cloudflare. Addresses are `user@cumuluscloud.app`. The product hosts are separate names on that domain.

No paid Cloudflare add-on is required to launch. Items that cost money are marked **Paid** and are optional.

Public record shapes below follow Cloudflare's Email Service domain configuration (routing MX, SPF, and the `cf2024-1` DKIM selector). Priorities and the DKIM public key are assigned in the Cloudflare dashboard. Copy those values from the dashboard. Do not invent a key.

## Hostnames

| Name | Use | Record | Proxy | Cost |
| --- | --- | --- | --- | --- |
| `cumuluscloud.app` | Apex. Mailbox domain for `user@cumuluscloud.app`. | MX and TXT below. No origin is required for launch. | MX and TXT stay DNS only. | Included |
| `id.cumuluscloud.app` | Cumulus://ID. Keycloak issuer and JWKS. | `A` / `AAAA` or `CNAME` when an ID host exists. | Proxied (orange cloud) is fine for HTTPS once an origin exists. Leave the name unpublished until then. | Included. Universal SSL is on the free plan. |
| `cloud.cumuluscloud.app` | Cumulus://Cloud. Drive public base URL and share links. | `A` / `AAAA` or `CNAME` when the Drive process has an origin. | Proxied is fine for HTTPS. | Included |
| `mail.cumuluscloud.app` | Cumulus://Mail web host. Not the MX target. | `A` / `AAAA` or `CNAME` when a mail UI exists. | Proxied is fine for HTTPS. | Included |

Do not point MX at `mail.cumuluscloud.app` or any proxied name. The Cloudflare proxy does not accept SMTP. If an MX target on this zone is proxied, Cloudflare publishes a `_dc-mx` bypass; avoid that setup.

## Email at user@cumuluscloud.app

Two inbound choices. Launch needs at most the free routing option. A real mailbox product is not required.

### Option A — Cloudflare Email Routing (launch default)

Forward `user@cumuluscloud.app` to an inbox the operator already has. Routing is included with Cloudflare. **Cost: none.**

Dashboard path: Compute → Email Service → Email Routing → Onboard Domain. Cloudflare writes and can lock these records. This file does not turn that on.

| Type | Name | Value | Proxy | Cost |
| --- | --- | --- | --- | --- |
| MX | `@` | `route1.mx.cloudflare.net` | DNS only | Included |
| MX | `@` | `route2.mx.cloudflare.net` | DNS only | Included |
| MX | `@` | `route3.mx.cloudflare.net` | DNS only | Included |
| TXT | `@` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | DNS only | Included |
| TXT | `cf2024-1._domainkey` | `v=DKIM1; …` public key shown by Cloudflare | DNS only | Included |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@cumuluscloud.app` | DNS only | Included |

MX priority is assigned by Cloudflare. Keep a single SPF TXT. `p=none` monitors DMARC without rejecting mail. Point `rua` at an address that Email Routing forwards to an existing inbox, or omit `rua` until that forward exists.

Create a routing rule for each address, including `dmarc@` if it is used. With Cloudflare MX in place, an address with no rule is rejected.

Outbound mail from the product is not required for launch. Cloudflare Email Sending is a separate onboard (records under `cf-bounce.cumuluscloud.app` and `cf-bounce._domainkey`). Leave it off until someone checks the current Email Sending price. **Cost: not required for launch.**

### Option B — a real mailbox provider

Google Workspace, Microsoft 365, Fastmail, and similar hosts replace the apex MX, SPF include, and DKIM selector with that vendor's values. **Paid. Not required for launch.**

If a provider is added later:

- Remove or replace the Email Routing MX records. Routing and a foreign MX cannot both own the apex.
- Merge SPF into one TXT. Stay within 10 DNS lookups.
- Keep the provider DKIM selector beside any Cloudflare selector. Selectors do not share a name.
- Keep DMARC at `_dmarc`, still `p=none` until reports look clean.

## TLS and proxy

| Item | Setting | Cost |
| --- | --- | --- |
| HTTPS for `id`, `cloud`, and `mail` | Cloudflare proxy on, Universal SSL | Included |
| Minimum TLS | TLS 1.2 on the free SSL/TLS setting | Included |
| Always Use HTTPS and Automatic HTTPS Rewrites | On, once a hostname is proxied | Included |
| Advanced Certificate Manager or a custom uploaded certificate | Not used | **Paid. Not required.** |
| MX, SPF, DKIM, DMARC | DNS only. Never proxied. | Included |

The Drive process in this repo speaks HTTP on the origin. TLS terminates at Cloudflare only after an origin exists. No certificate purchase is required.

## CORS origins

The Drive allowlist is exact origins. It never uses `*`.

Default:

- `https://id.cumuluscloud.app`
- `https://cloud.cumuluscloud.app`
- `https://mail.cumuluscloud.app`

A browser on any other origin, including `http://` copies of those hosts, receives no `Access-Control-Allow-Origin` header.

## Environment variables

Set these on the Drive process. Defaults match the table above. See `.env.example`.

| Variable | Default |
| --- | --- |
| `CUMULUS_ROOT_DOMAIN` | `cumuluscloud.app` |
| `CUMULUS_ID_HOST` | `id.cumuluscloud.app` |
| `CUMULUS_CLOUD_HOST` | `cloud.cumuluscloud.app` |
| `CUMULUS_MAIL_HOST` | `mail.cumuluscloud.app` |
| `CUMULUS_KEYCLOAK_ISSUER` | `https://id.cumuluscloud.app/realms/cumulus` |
| `CUMULUS_KEYCLOAK_AUDIENCE` | `https://id.cumuluscloud.app` |
| `CUMULUS_KEYCLOAK_JWKS_URL` | `https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs` |
| `CUMULUS_PUBLIC_BASE_URL` | `https://cloud.cumuluscloud.app` |
| `CUMULUS_CORS_ORIGINS` | the three `https://` origins, comma-separated. A `*` value is rejected. |

Also required before the process will listen, and not DNS: `CUMULUS_KMS_MASTER_KEY`, `CUMULUS_BOOTSTRAP_TOKEN`, `CUMULUS_SHARE_SECRET`.

## id.cumuluscloud.app and cloud.cumuluscloud.app

Free launch does not publish these names. Supabase custom domains are a paid add-on, so Auth and the Drive function stay on the existing free project hostname. This repository does not create the DNS records, does not apply migrations to project `ivqiskeziohbbtkcvlun`, and does not deploy.

| Name | Free origin | When to publish DNS | Cost |
| --- | --- | --- | --- |
| `id.cumuluscloud.app` | `https://ivqiskeziohbbtkcvlun.supabase.co/auth/v1` (issuer and JWKS). Keycloak mode still expects this hostname once an ID origin exists. | After an ID origin exists. Do not CNAME this name at the Supabase project hostname. | Included. A Supabase custom domain is **Paid. Not required.** |
| `cloud.cumuluscloud.app` | Drive function path `/functions/v1/drive` on the same project. Share links use this hostname via `CUMULUS_PUBLIC_BASE_URL`. | After a Drive origin exists. | Included. A Supabase custom domain is **Paid. Not required.** |

Dashboard steps, later, when an origin exists. Until then, leave both names unpublished. **Cost of leaving them unpublished: none.**

1. Cloudflare dashboard → `cumuluscloud.app` → DNS → Records → Add record.
2. Add a CNAME named `id`. Target is the ID origin. Proxy status: Proxied (orange cloud), so Universal SSL serves `https://id.cumuluscloud.app`.
3. Add a CNAME named `cloud`. Target is the Drive origin. Proxy status: Proxied, so `https://cloud.cumuluscloud.app` is covered by Universal SSL.
4. SSL/TLS → Overview → Full. Edge Certificates → Minimum TLS Version → TLS 1.2. Turn on Always Use HTTPS.
5. Do not point either CNAME at `ivqiskeziohbbtkcvlun.supabase.co` unless that exact hostname has a verified Supabase custom domain. Without the paid add-on, that CNAME fails TLS. It is not the launch setup.

Supabase mode checks the project JWKS and takes `cid` from `app_metadata.cid`. Keycloak mode remains available and still uses `https://id.cumuluscloud.app` when that host is the issuer.

## What launch does not need

- Publishing `id`, `cloud`, or `mail` before an origin exists. **Included when you do publish them.**
- A paid mailbox. **Paid if chosen.**
- Cloudflare Email Sending. **Check price before use. Not required.**
- A paid TLS certificate. **Paid if chosen.**
- Applying this document. DNS edits stay a manual dashboard step.
