# Cumulus://Cloud — authenticated Drive and explicit-consent publishing

Status: design for review. This document is the only change in its pull request. No application code, migration, website edit, deployment, or merge is authorized by writing it down.

Product: one product, Cumulus://Cloud. Private Drive and opt-in dataset publishing are surfaces of that product. The GitHub repository name `cumulus-exchange` is the repo slug, not a second product.

Repository inspected: `InfinitumCorp/cumulus-exchange` at `daa04c24637d9f59f7951f23ff5ceddf5b8462b4` on `main`. Other Infinitum repositories were not readable with this credential. Unreadable is an access limit, not evidence that those repositories are empty.

## Decision

Build a real server-side Drive: authenticated uploads and downloads of bytes that survive a process restart, private by default, with a separate explicit publish step that stores an aggregate-only public document. Do not extend the browser `localStorage` demo (`cumulus-exchange-v1`) into this flow.

The demo wallet, CDAT mint, 85% split, and Firmament hash chain stay in the existing Zustand screens. Those screens are labeled **Demo ledger (this browser only)** and are not called by Drive handlers. Drive handlers never read or write `localStorage`.

This slice does not sell data, mint a token, settle a payment, start a GPU, or accept a government tenancy. There is no sale endpoint.

## Backend chosen

Use the database and auth already in this repo. Do not add a second database product.

| Concern | Choice | Why |
|---|---|---|
| Identity | Better Auth, already constructed in `src/lib/auth/server.ts` | Session cookie `__Host-grok-auth.session_token`, or the preview bearer token. `requireUserId` in `src/lib/auth/verify.server.ts` is the only identity Drive accepts. |
| Request guard | `authMiddleware` in `src/lib/auth/middleware.ts` plus `assertSameSiteRequest` in `src/lib/auth/isolation.server.ts` | Every Drive operation goes through both. A scripted cross-site request is 403 before any query. |
| Metadata | Existing `getSql()` in `src/lib/db.ts` | `DATABASE_URL` selects the `pg` pool (self-hosted Postgres or Neon). Unset selects PGLite. |
| Durable dev database | File-backed PGLite when `DATABASE_URL` is unset | `@electric-sql/pglite` is already a dependency. `server.ts` already calls `getPglite()` on that path, so auth rows and Drive rows share one database. The implementation passes `dataDir: CUMULUS_PGLITE_DIR`. Today `createPgliteSql` opens memory and the file comment says a restart wipes it. Memory mode is not Drive-ready. |
| Bytes | Local filesystem adapter behind `BlobStore` | Real `rename` onto a directory the operator owns. An S3-compatible driver is a later replacement of this interface. This slice does not import an S3 client and does not call a paid API. |
| Sign-in for self-host and tests | `emailAndPasswordEnabled = true` in `src/lib/auth/email-password.ts` | That flag is the supported switch. `server.ts` already spreads `emailAndPassword` from it. Broker sign-in stays as wired for preview and deploy. |

`src/lib/auth/server.ts` is not rewritten. The implementation copies `migrations/auth/0001_auth.sql` verbatim to `migrations/0001_auth.sql` so both appliers (`scripts/migrate.mjs` and the PGLite glob) create the Better Auth tables. `scripts/migration-plan.mjs` keys by basename, so a database that already applied `0001_auth.sql` does not run it twice. App tables are a new `migrations/0002_cumulus_drive.sql`. Neither applier reads `migrations/auth/` until that copy exists.

## What is durable, and what is not

A Drive route returns **503** `storage_unconfigured` unless every line below is true. It does not fall back to memory, `localStorage`, or the dev user.

1. **Database is durable.** Either `DATABASE_URL` is non-empty, or `DATABASE_URL` is unset and `CUMULUS_PGLITE_DIR` is an absolute path outside the repository root. The in-memory PGLite path (neither set) is not durable.
2. **Blob driver is the local one this slice implements.** `CUMULUS_BLOB_DRIVER` is unset or `local`. Any other value, including `s3`, is `storage_unconfigured`.
3. **Blob root is a private absolute directory outside the repository.** `CUMULUS_BLOB_ROOT` is absolute, is not inside the repo, and is created mode `0700`.
4. **The process is allowed to keep a local disk.** `VERCEL` is unset and `GROK_PROJECT_ID` is unset. Both are set by the hosted deploy path described in `src/lib/env.server.ts` and by Vercel. On that path the function filesystem is not a private durable disk, so the local driver refuses to serve even if a root is set.

Auth is a separate gate, checked first: missing session is **401**, not 503.

Restart behavior the tests must show:

- File-backed PGLite plus `CUMULUS_BLOB_ROOT` keep the user row, the object row, and the bytes after the Node process exits. PGLite is single-writer. Process 2 starts only after process 1 has exited. Two servers must not open one `CUMULUS_PGLITE_DIR`.
- The preview auth secret in `server.ts` is `randomBytes` on `globalThis` unless `BETTER_AUTH_SECRET` is set. A restart test re-signs-in with email and password. It does not depend on the cookie surviving. Self-host sets `BETTER_AUTH_SECRET` (at least 32 bytes). The spec does not generate a production secret.
- `npm run dev` without the two directories still boots the current demo UI. Drive actions show the unconfigured state and issue no object row.

Deployed limits, stated as limits:

- Metadata can live in Neon when the platform injects `DATABASE_URL`. `scripts/migrate.mjs` applies `migrations/*.sql` in a transaction per file during `npm run build` **only when `DATABASE_URL` is set**. Verification of this spec unsets `DATABASE_URL` for build and typecheck so a production database is not migrated. The repo contains no database URL.
- Bytes on Vercel do not survive, and the local driver is disabled there. Until an operator sets a future blob driver this slice does not implement, hosted Drive stays 503. No bucket is created here.
- In-memory PGLite still backs a preview that has no `CUMULUS_PGLITE_DIR`. That preview can sign in through the existing broker, and Drive still returns 503. Sessions in memory still disappear on restart. That is the current `db.ts` behavior, and Drive does not pretend otherwise.

## Identity, tenancy, and fail-closed auth

The owner of every row is `session.user.id` from Better Auth. Handlers ignore a client-sent user id, email, or owner field.

`requireUserId` returns the shared `dev-user` when `VITE_AUTH_ENABLED=false` and `DATABASE_URL` is unset. Drive does not use that branch. A Drive handler treats `dev-user`, a missing session, and `authConfigured === false` with gate identity off as **401** `Unauthorized`. When `VITE_AUTH_ENABLED=false` and `DATABASE_URL` is set, `requireUserId` already throws. Leave that throw in place.

Do not set `VITE_AUTH_ENABLED=false`, and do not add `.grok/app-env.json`, to make the inherited script tests pass. Missing `.grok/app-env.json` means no override. `src/lib/auth/client.ts` treats that as auth on (`authEnabled` is `import.meta.env.VITE_AUTH_ENABLED !== "false"`). `scripts/with-app-env.mjs` says a missing file is an empty overlay, and a deployed build takes `VITE_AUTH_ENABLED` from the platform (injected as `"true"`). Drive follows the auth-on path.

Cross-tenant rule: load and mutate with `where id = $1 and owner_user_id = $2`. Another user's id returns **404** for object download, object delete, preview, publish, and revoke. The body is `{"error":"not_found"}`. It does not echo the other user's bytes, name, or path. Public dataset GET is the exception below, and it never joins private columns.

Same-site: HTTP Drive routes call `assertSameSiteRequest` before `requireUserId`. A `Sec-Fetch-Site` of `cross-site` or `same-site` on a scripted request is **403**.

## Blob store

```ts
interface BlobStore {
  put(rel: string, sourcePath: string): Promise<void>; // atomic rename on the same filesystem
  open(rel: string): Promise<NodeJS.ReadableStream>;
  remove(rel: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
}
```

`rel` is `` `${userDir}/${objectId}` ``. `userDir` is the hex SHA-256 of the Better Auth user id (64 lowercase hex characters). `objectId` is a server-generated UUID v4. The client never supplies `rel`. `path.resolve(root, rel)` must start with `path.resolve(root) + path.sep`. A failure of that check is **500** `storage_path_rejected` and writes nothing.

`LocalBlobStore` is the only implementation in this slice. A later `s3` module would implement the same four methods and would be selected only when `CUMULUS_BLOB_DRIVER=s3` **and** the local-disk prohibition above is the reason local is off. That module is not part of this design's implementation. Naming the env var now is so the refusal code has a stable string to reject.

## Upload contract

`POST /api/drive/objects`

Headers:

- Cookie session or `Authorization: Bearer` (the existing preview path).
- `Idempotency-Key`: UUID.
- `Content-Type`: one of the allowlist below.
- `X-Display-Name`: optional, at most 180 characters. Stored as a private label. Never used as a path.

Body: raw bytes. Not JSON. Cap **26,214,400** bytes (25 MiB), counted while streaming. Over the cap, delete the temp file, write no `stored` row, return **413** `too_large`.

Allowlist and magic:

| Content-Type | Magic |
|---|---|
| `image/jpeg` | `FF D8 FF` |
| `image/png` | `89 50 4E 47 0D 0A 1A 0A` |
| `image/gif` | `GIF87a` or `GIF89a` |
| `image/webp` | `RIFF` at 0 and `WEBP` at 8 |
| `application/pdf` | `%PDF-` |
| `text/plain`, `text/csv` | UTF-8, no NUL in the first 8 KiB, no leading `<svg`, `<html`, or `<!DOCTYPE html` (case-insensitive, leading whitespace skipped) |
| `application/json` | UTF-8, `JSON.parse` succeeds, same markup rejection |

Anything else, or a magic mismatch, is **415** `type_rejected`. SVG, HTML, and zip are not in the allowlist. The temp file is removed.

Display name: strip `../`, `/`, `\`, and code points below `U+0020`. If nothing remains, store `file`. The original header is not stored.

Quota: at most **100** rows per owner with status `stored`. The 101st is **409** `quota_objects`. The count and the insert share a transaction that locks `drive_quota_lock` for that user (`insert ... on conflict do nothing`, then `select ... for update`).

`request_sha256` is the SHA-256 of the UTF-8 string `mediaType + "\n" + displayName + "\n" + byteSha256`. It is stored on `drive_object` only as `sha256` for the bytes, and on `drive_idempotency` only after success.

Steps:

1. Auth, same-site, storage-ready. Otherwise 401, 403, or 503.
2. Look up `drive_object` by `(owner_user_id, idempotency_key)`. Recompute `request_sha256` from the row's `media_type`, `display_name`, and `sha256`. Status `stored` and an equal hash returns `{ "id", "byteSize", "mediaType", "displayName", "status": "stored" }` with **201** and writes nothing. The same key with a different hash is **409** `idempotency_conflict`. Status `pending` is **409** `upload_in_progress`. Status `aborted` or `deleted` is **409** `upload_aborted` (the key is spent).
3. Stream to `CUMULUS_BLOB_ROOT/.tmp/<uuid>`. On validation failure, unlink it and insert nothing.
4. Transaction: lock the quota row, insert `drive_object` status `pending` with `sha256` set to the byte hash. Commit.
5. `BlobStore.put` renames the temp onto the final `rel`. On rename failure, set status `aborted`, unlink the temp, audit `upload_aborted`, return **500** `store_failed`.
6. Transaction: set status `stored`, set `stored_at`, insert `drive_idempotency` with that same 201 body, append `audit_event` `upload_stored`. Commit. A crash after a successful rename and before this commit leaves `pending` plus a final file. The sweeper reconciles that pair to `stored` and inserts the 201 body if it is missing. It does not delete the file.

`request_sha256` and the private `sha256` column are hashes of bytes. They are not returned from the public dataset API.

Download `GET /api/drive/objects/:id`: owner and status `stored` only, else 404. Stream the blob. `Content-Disposition: attachment` with the sanitized display name, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. Content-Type is the stored allowlisted type.

List `GET /api/drive/objects`: the caller's rows that are `stored` or `pending`. Fields: `id`, `byteSize`, `mediaType`, `displayName`, `status`, `createdAt`. No other user's rows.

Delete `DELETE /api/drive/objects/:id`: owner only. If a `dataset_object` row joins a dataset with status `listed`, **409** `file_in_listed_dataset` and the blob stays. Otherwise set status `deleting`, unlink, then set `deleted`. The row remains so historical links still have a target. `display_name` stays on that private row and is still absent from public JSON.

## Public document

Media type: `application/vnd.cumulus.aggregate+json`.

The document is inspired by Croissant field names (`name`, `description`, `license`, `version`, `datePublished`, `recordSet`, `field`, `dataType`) from [mlcommons/croissant](https://github.com/mlcommons/croissant), Apache-2.0. This slice does not vendor that repository and does not copy its spec text. The document omits `@context` and `@type`, and it sets `distribution` to an empty array so private objects are not described as Croissant `FileObject`s. `croissantCompliant` is `false`. Validators must not be told this is a conforming Croissant dataset.

Canonical form is the only form previewed, stored, and served: UTF-8, keys sorted lexicographically at every object, no insignificant whitespace, integers in decimal without leading zeros. SHA-256 is computed over those exact bytes.

```json
{
  "croissantCompliant": false,
  "datePublished": "2026-11-07T00:00:00.000Z",
  "description": "Counts and sizes by media type.",
  "distribution": [],
  "license": "https://creativecommons.org/licenses/by/4.0/",
  "name": "Usage aggregates",
  "recordSet": [
    {
      "field": [
        {
          "dataType": "sc:Integer",
          "name": "file_count",
          "value": 1
        },
        {
          "dataType": "sc:Text",
          "name": "count_by_media_type",
          "value": { "application/pdf": 1 }
        },
        {
          "dataType": "sc:Integer",
          "name": "total_bytes",
          "value": 12
        }
      ],
      "name": "aggregates"
    }
  ],
  "spec": "cumulus-aggregate-v1",
  "version": "1.0.0"
}
```

`name` and `description` are the publisher's title and text (1–120 and 1–600 characters). The server rejects the preview with **400** `echoes_private_name` when either string contains an included object's `display_name`, `id`, or byte SHA-256. Aggregates are computed from `drive_object.byte_size` and `media_type` only. Publish does not read blob bytes. A file body therefore cannot be copied into the document by the aggregator.

`license` is fixed to CC BY 4.0 for this aggregate document. That license applies to the aggregate JSON the publisher chose to list. It is not a license to the private files, which are not distributed.

The fixed consent scope is the string `aggregate_metadata_v1`: file count, total bytes, and counts by allowlisted media type, for the object ids in the request, at preview time. Version integer on the consent row is **1**. A wider scope is a different product change, not an edit of this row.

## Preview, publish, revoke

`POST /api/drive/datasets/preview` with `{ "objectIds": ["..."], "name": "...", "description": "..." }`.

One to 100 ids. Each must be `stored` and owned, else **404**. Response is `{ "canonical": <object>, "sha256": "<hex>" }` using the serializer above. Nothing is inserted. Default after upload is no preview and no consent row.

`POST /api/drive/datasets` with header `Idempotency-Key` and body `{ "objectIds", "name", "description", "previewSha256", "consent": true }`.

`consent` must be boolean `true`, else **400** `consent_required` and no insert. The server rebuilds the canonical document from current rows. If its SHA-256 differs from `previewSha256`, **409** `preview_stale` and no insert. On match, one transaction:

1. Lock `drive_quota_lock` for the owner.
2. Re-read the objects `for update` and recompute. A mismatch is still `preview_stale`.
3. Insert `dataset` (`listed`), `dataset_object` links, `consent` (immutable), and `audit_event` `publish`.
4. Insert the idempotency response body.

Unique `(owner_user_id, idempotency_key)` makes a concurrent duplicate fail the insert. The loser rolls back and returns the winner's response when the request hash matches, else **409** `idempotency_conflict`. A database error rolls back all four inserts. Publish writes no blob, so there is no publish orphan.

`GET /api/drive/datasets` and `GET /api/drive/datasets/:id` require no session. They return canonical JSON only for `status = 'listed'`. Missing or not listed is **404**. The SQL selects `canonical_json` only. It does not select `display_name`, `sha256`, or `rel`.

`POST /api/drive/datasets/:id/revoke` requires the owner session. One transaction: if status is `listed`, set `revoked`, set `revoked_at`, insert `consent_revocation`, insert `audit_event` `revoke`. If status is already `revoked` for that owner, return **200** with the same revocation body (idempotent). If the id is unknown or owned by someone else, **404**.

After revoke, public GET is **404**. Private download by the owner still works. Revoke does not delete bytes.

Prior-recipient limit, shown in the revoke response and on the dataset screen: this server never pushed the document to a buyer, and it has no licensee table. Revoke stops new reads. A copy someone already downloaded is outside this server, and the response says that in the field `priorCopiesRemain: true`. There is no clawback claim.

## Schema

`migrations/0002_cumulus_drive.sql` (applied only in the implementation pull request):

```sql
create table drive_quota_lock (
  owner_user_id text primary key references "user" ("id")
);

create table drive_object (
  id text primary key,
  owner_user_id text not null references "user" ("id"),
  byte_size integer not null check (byte_size > 0 and byte_size <= 26214400),
  media_type text not null,
  sha256 text not null,
  display_name text not null,
  status text not null check (status in ('pending', 'stored', 'aborted', 'deleting', 'deleted')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  stored_at timestamptz,
  unique (owner_user_id, idempotency_key)
);

create index drive_object_owner_idx on drive_object (owner_user_id);

create table dataset (
  id text primary key,
  owner_user_id text not null references "user" ("id"),
  status text not null check (status in ('listed', 'revoked')),
  canonical_json text not null,
  payload_sha256 text not null,
  idempotency_key text not null,
  listed_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (owner_user_id, idempotency_key)
);

create index dataset_listed_idx on dataset (status);

create table dataset_object (
  dataset_id text not null references dataset (id),
  object_id text not null references drive_object (id),
  primary key (dataset_id, object_id)
);

create table consent (
  id text primary key,
  owner_user_id text not null references "user" ("id"),
  dataset_id text not null unique references dataset (id),
  version integer not null check (version = 1),
  scope text not null check (scope = 'aggregate_metadata_v1'),
  purpose text not null check (purpose = 'dataset_publishing'),
  statement_sha256 text not null,
  payload_sha256 text not null,
  granted_at timestamptz not null default now()
);

create table consent_revocation (
  id text primary key,
  consent_id text not null unique references consent (id),
  dataset_id text not null references dataset (id),
  actor_user_id text not null references "user" ("id"),
  revoked_at timestamptz not null default now()
);

create table audit_event (
  id text primary key,
  actor_user_id text not null,
  action text not null check (action in (
    'upload_stored', 'upload_aborted', 'download', 'delete', 'preview', 'publish', 'revoke'
  )),
  object_id text,
  dataset_id text,
  detail jsonb not null,
  at timestamptz not null default now()
);

create table drive_idempotency (
  owner_user_id text not null references "user" ("id"),
  idempotency_key text not null,
  request_sha256 text not null,
  response_status integer not null,
  response_json text not null,
  primary key (owner_user_id, idempotency_key)
);
```

`consent` has no update path in the handlers. Revocation is a new row. `detail` on an audit event may contain ids, counts, byte sizes, and media types. It must not contain `display_name`, a path, or file bytes. Downloads append `download` with `{ "objectId" }` only.

The consent statement whose SHA-256 is stored is this exact UTF-8 sentence: `I publish counts and sizes by media type for the files I selected. File names, paths, and contents stay private. This is not a sale.`

## Orphans and retention

A sweeper runs at process start and every five minutes. It touches only rows and files older than 15 minutes:

| Found | Action |
|---|---|
| `pending` and the final file exists | Set `stored`, insert the idempotency 201 body if it is missing, audit `upload_stored`. |
| `pending` and no final file | Unlink the temp if present, set `aborted`, audit `upload_aborted`. |
| `deleting` | Unlink the final file if present, set `deleted`, audit `delete`. |
| File under the blob root whose `rel` matches no row | Unlink it. |
| `stored` row whose final file is missing | Set `aborted`, audit `upload_aborted`. Later download is 404. |
| Temp file in `.tmp` with no `pending` row | Unlink it. |

Rows younger than 15 minutes are left for the request that owns them. Rename and the sweeper can both run; `put` is an atomic rename, and the sweeper ignores young temps.

Retention for this slice: private bytes remain until the owner deletes them or the sweeper aborts a broken `stored` row. Revoke does not delete them. This slice has no account-deletion API. Deleting a Better Auth user is not offered, so `on delete cascade` from `"user"` is not the deletion path.

## UI

One shell, title **Cumulus://Cloud**. Sign-in page document title: `Cumulus://Cloud — Infinitum Corporation®`. This slice does not add a contact footer and does not change the marketing site. A contact line, if one is added later, uses Infinitum Corporation® and 202-729-9509.

Implementation adds `src/routes/login.tsx` and `src/routes/api/auth/$.ts` for the existing Better Auth handler, with email and password enabled. It does not add `src/routes/auth/popup.tsx`.

Navigation:

| Control | Opens |
|---|---|
| Store | Private Drive for the signed-in user |
| Publish | Preview and consent for files selected on Drive |
| Revoke | The owner's listed datasets |
| Demo ledger | Existing market, licenses, query, collect, and ledger |

Store, while signed out, shows sign-in. It does not list files. While storage is unconfigured, it shows that sentence and does not show an empty library that looks successful.

Drive lists the caller's objects, an upload control, download, and delete. Publish shows the canonical JSON the server returned, then the consent sentence as a checkbox that must be checked before the publish button enables. The button posts `consent: true` and the preview SHA-256. Revoke shows `priorCopiesRemain: true` with the sentence from the revoke contract.

The demo ledger keeps its simulated wallet and CDAT behavior and never receives upload bytes.

## Security checks the implementation must keep

- No Drive query without `owner_user_id` from the server session, except the two public dataset reads, which select `canonical_json` where `status = 'listed'`.
- Absent blob root, absent durable database, local disk on Vercel, or `CUMULUS_BLOB_DRIVER` other than `local`: 503 before a write.
- Auth off or `dev-user`: 401. Do not flip `VITE_AUTH_ENABLED` to false.
- Upload path is server-built. `X-Display-Name: ../../SENTINEL` does not create a file outside `CUMULUS_BLOB_ROOT`.
- Download of another user's object id: 404 and a body that does not contain the bytes.
- Public listing of a dataset built from a file whose display name is `SENTINEL_NAME` and whose body is `SENTINEL_CONTENT`: the HTTP body does not contain either string.
- Government and private workloads: no tenancy, no classifier, and no sale API. The consent sentence says contents stay private and this is not a sale. Structural refusal is the control this slice has. It does not scan bytes for classification banners.

## Test plan

New tests live in `src/lib/drive/drive.integration.test.ts` and run as `npm run test:drive`, a separate script from `npm test`. They create `CUMULUS_PGLITE_DIR` and `CUMULUS_BLOB_ROOT` under `os.tmpdir()`, set `BETTER_AUTH_SECRET` to a fixed 32-byte test value, and unset `DATABASE_URL`. They sign up two email users through Better Auth against that database.

| Test | Expected |
|---|---|
| Upload bytes, exit the process, start a second process, sign in as the same user, download | Byte-for-byte match |
| User B downloads user A's object id | 404, body has neither A's bytes nor `SENTINEL_NAME` |
| Fresh user, no publish | `GET /api/drive/datasets` is `[]`, consent table is empty |
| Publish that file, read the public document | Body lacks `SENTINEL_NAME` and `SENTINEL_CONTENT` |
| Publish twice with one idempotency key | One dataset row, same id |
| Publish with `consent: false` or a stale `previewSha256` | 400 or 409, no dataset row |
| Revoke, then public GET, then owner download | Public 404, owner still receives bytes, second revoke is 200 |
| No session, `Content-Type: application/zip`, 25 MiB + 1, display name with `../` | 401, 415, 413, and no file outside the blob root |
| `npm run typecheck` and `npm run build` with `DATABASE_URL` unset | Typecheck does not open a database. Build logs `[migrate] DATABASE_URL not set — skipping` and does not connect |

Inherited script failures stay inherited. On this checkout `npm test` runs `scripts/**/*.test.mjs` first and stops before the TypeScript tests. Eight failures come from a missing `.grok/` tree, not from Drive:

| Test | Cause |
|---|---|
| `scripts/brand-check.test.mjs` 27, 28, 29 | Missing `.grok/skills/og/SKILL.md` |
| `scripts/write-atomic.test.mjs` 196 | Missing `.grok/skills/og/references` |
| `scripts/check-auth-invariant.test.mjs` 79 | Expects shipped app-env to resolve auth disabled; `.grok/app-env.json` is absent, so the resolver does not return `false` |
| `scripts/with-app-env.test.mjs` 180, 182, 186 | Expect `{ VITE_AUTH_ENABLED: "false" }`; the missing file reads as `{}` and the child sees `undefined` |

Do not edit those assertions and do not add the missing file with auth disabled. A red `npm test` from this list is not a Drive regression. A red `npm run test:drive` is.

## Acceptance criteria

1. Store opens a private Drive. Publish and revoke are separate steps. The demo ledger is still reachable and labeled as browser-only.
2. Two processes, one file-backed PGLite directory and one blob root, show the same bytes after a full process exit and a new sign-in.
3. User B cannot read user A's object. An anonymous caller cannot upload.
4. A user with only uploads has no consent row and no public dataset.
5. The public document for a sentinel file contains neither the file name nor the file body, and `croissantCompliant` is false.
6. Publish is one transaction. A repeated idempotency key does not insert a second dataset. A failed consent or a stale preview inserts nothing.
7. Revoke removes the document from public GET and does not delete the owner's bytes. The response sets `priorCopiesRemain` to true.
8. Oversized, disallowed, and unauthenticated uploads leave no `stored` row and no file outside the blob root.
9. Missing durable database, missing blob root, or a hosted process (`VERCEL` or `GROK_PROJECT_ID`) returns 503 for Drive and does not write.
10. `env -u DATABASE_URL npm run typecheck` and `env -u DATABASE_URL npm run build` do not connect to a database.
11. `npm run test:drive` covers the rows above. The eight inherited `.grok` failures are unchanged and are not silenced by turning auth off.

## Implementation boundary

The next pull request, after this spec is approved, may edit application code to match this document. It may not add an S3 client, a payment, a token, a GPU path, a government tenancy, or a change to the marketing site.

## Deployment-only decisions left

These are operator choices at deploy time. The runtime behavior when they are unset is already fixed above.

1. Hosted object storage: which S3-compatible endpoint, bucket, and credentials an operator will supply when they want Drive on Vercel. This slice ships no driver for that, so hosted Drive stays 503.
2. Hosted metadata: the platform already injects `DATABASE_URL` for Neon on deploy. This spec does not create a project or run a migration against it.
3. Hosted auth secret and broker client: the platform injects `BETTER_AUTH_SECRET` and `GROK_AUTH_*` on deploy. A self-host operator sets `BETTER_AUTH_SECRET` and uses email and password. No new identity provider is introduced.
