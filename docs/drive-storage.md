# Cumulus Drive storage

Cumulus://Cloud keeps private files on a self-hosted Node process. This build does not use paid object storage.

Bytes go to `CUMULUS_BLOB_ROOT`. Account, quota, and share rows go to file-backed PGLite at `CUMULUS_PGLITE_DIR`. Both directories must already exist, be absolute paths outside the repository, and be real directories rather than symlinks. The process creates files mode `0600` and directories mode `0700`.

Unset `DATABASE_URL`. If it is set, Drive refuses to start so it cannot write to a hosted database. `VERCEL` or `GROK_PROJECT_ID` also refuse Drive, because that disk is ephemeral.

## Start

```sh
mkdir -m 700 -p /var/lib/cumulus/blobs /var/lib/cumulus/pglite
export CUMULUS_BLOB_ROOT=/var/lib/cumulus/blobs
export CUMULUS_PGLITE_DIR=/var/lib/cumulus/pglite
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
unset DATABASE_URL
npm run dev
```

Generate `BETTER_AUTH_SECRET` on the machine. Do not commit it. Local sign-in is email and password stored in the PGLite directory (`/api/auth/sign-up/email` and `/api/auth/sign-in/email`). `http://localhost:8080` stays a trusted origin. Leave `BETTER_AUTH_URL` unset for that local server.

The public origin is the exact URL `https://cumuluscloud.app`. Set `BETTER_AUTH_URL` to that value only on the process that actually serves it. Session cookies stay `__Host-` names with no `Domain` attribute, so they are not shared with subdomains. These names are proposed only and are not trusted origins and not DNS records from this repo: `id.cumuluscloud.app`, `cloud.cumuluscloud.app`, `mail.cumuluscloud.app`.

This app does not accept another product's session. Cumulus://ID single sign-on is not implemented here. The demo ledger address `demo.alex@cumuluscloud.app` is a label in the browser, not a mailbox and not a user row.

Optional limits:

| Name | Default |
|---|---|
| `CUMULUS_DRIVE_QUOTA_BYTES` | 104857600 (100 MiB) |
| `CUMULUS_DRIVE_MAX_OBJECT_BYTES` | 26214400 (25 MiB), also capped by the quota |
| `CUMULUS_DRIVE_STALE_MS` | 900000 (15 minutes) |

## What is stored

`POST /api/drive/objects` with a session cookie, `Content-Type`, `Idempotency-Key` (UUID), and optional `X-Display-Name`. The name is a label. The on-disk key is `drive/<sha256(user id)>/<uuid>`.

`GET /api/drive/objects` lists only that account. `GET` and `DELETE /api/drive/objects/:id` are owner-only and return 404 for everyone else.

`POST /api/drive/objects/:id/shares` with `{ "consent": true, "expiresInSeconds": 3600 }` returns a token once. The database stores only its SHA-256. `GET /api/drive/shared` with `Authorization: Bearer <token>` streams that one file after checking the hash, expiry, and revocation. `DELETE /api/drive/shares/:id` revokes it. The next request fails. A download that already started can finish. This is not an S3 presigned URL, which would stay valid until it expired.

Allowed types are checked from the bytes: jpeg, png, gif, webp, pdf, plain text, csv, json, mp4, webm, and `application/vnd.cumulus.sealed`. A sealed object must start with the `CMLS` header. The console produces that header in the browser. The key is not sent. Folders, trash, stars, versions, share passwords, download limits, Cumulus://ID grants, chunked upload, and the audit read API are in `migrations/0003_drive_parity.sql`. The checklist is `docs/proton-parity.md`.

Quota counts reserved bytes for an upload that has not finished, and stored bytes after it has. Two uploads that together exceed the quota cannot both commit. A failed write releases the reservation. Rows left `pending` or `deleting` for `CUMULUS_DRIVE_STALE_MS` are reconciled on the next Drive call: a pending row with bytes on disk becomes stored; a pending row without bytes is aborted; a deleting row deletes the file and releases quota.

## Recovery

Stop the process before copying either directory. PGLite is one writer. Copy `CUMULUS_PGLITE_DIR` and `CUMULUS_BLOB_ROOT` together. Restoring one without the other leaves rows pointing at missing files, or files with no owner. After a crash, start the same process with the same directories and call any Drive route. Reconciliation finishes interrupted uploads and deletes.

## Moving to R2 later

Callers use a `BlobStore` with `put`, `get`, `remove`, and `exists`. A future adapter can implement that for R2 or S3. The upload, download, share, delete, auth, and quota code stay. Existing bytes still have to be copied, `object_key` rows checked, and the process pointed at the new adapter. That is a migration. It is not free of operational work, and this build does not ship the adapter.

## Launch checks

- Directories exist, are outside the repo, and are not symlinks.
- `DATABASE_URL`, `VERCEL`, and `GROK_PROJECT_ID` are unset.
- `BETTER_AUTH_SECRET` is set and at least 32 characters.
- `npm run test:drive` passes against a temp directory.
- `env -u DATABASE_URL npm run typecheck` and `env -u DATABASE_URL npm run build` do not open a database.
- The eight inherited `npm test` failures from a missing `.grok/` tree are separate. Do not set `VITE_AUTH_ENABLED=false` to hide them.

## Limits

One Node process. No hosted Vercel disk. No public bucket. Share tokens stop future reads when revoked; they do not interrupt a stream already in progress. Deleting an account is not implemented. Government or paid listing is not part of this surface. The browser demo ledger is not Drive.

`https://cumuluscloud.app` is not delegated, certified, or serving this app from this repository. Before that host can answer, DNS has to be set at the registrar, TLS issued, and a self-hosted Node process pointed at the volume above with `BETTER_AUTH_URL=https://cumuluscloud.app`. Broker OAuth, if used, needs that exact callback registered on the broker. This repo does not do those steps. Email and password on localhost does not need them. Mail delivery is another repository. Proposed hosts `id.cumuluscloud.app`, `cloud.cumuluscloud.app`, and `mail.cumuluscloud.app` are not trusted origins and are not live DNS.
