import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { closeDb, getPglite, getSql } from "@/lib/db";
import { newObjectKey, type BlobStore } from "@/lib/drive/blob-store";
import { readDriveConfig, type DriveConfig } from "@/lib/drive/config";
import { DriveError } from "@/lib/drive/errors";
import { localBlobStore, prepareBlobRoot } from "@/lib/drive/local-blob";
import { isAllowedType, magicMatches, type AllowedType } from "@/lib/drive/magic";
import { isPreviewClass } from "@/lib/drive/preview-class";

type Row = Record<string, unknown>;

interface Queryable {
  query<T = Row>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface ObjectRow {
  id: string;
  owner_user_id: string;
  byte_size: number;
  media_type: string;
  sha256: string;
  display_name: string;
  object_key: string;
  status: string;
  idempotency_key: string;
  created_at: string | Date;
  folder_id?: string | null;
  trashed_at?: string | Date | null;
  starred?: boolean;
  version_group?: string | null;
  version_number?: number;
  is_current?: boolean;
  preview_class?: string | null;
}

interface Ready {
  config: DriveConfig;
  store: BlobStore;
}

let readyPromise: Promise<Ready> | null = null;

async function ready(): Promise<Ready> {
  readyPromise ??= loadReady().catch((err) => {
    readyPromise = null;
    throw err;
  });
  return readyPromise;
}

async function loadReady(): Promise<Ready> {
  const config = await readDriveConfig();
  const root = await prepareBlobRoot(config.blobRoot);
  await getSql();
  return { config, store: localBlobStore(root) };
}

async function database(): Promise<Queryable & { transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> }> {
  await getSql();
  return getPglite();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function audit(
  db: Queryable,
  actor: string,
  action: string,
  objectId: string | null,
  shareId: string | null,
) {
  await db.query(
    "insert into drive_audit (id, actor_user_id, action, object_id, share_id) values ($1, $2, $3, $4, $5)",
    [randomUUID(), actor, action, objectId, shareId],
  );
}

async function ensureQuota(db: Queryable, userId: string, quota: number) {
  await db.query(
    `insert into drive_quota (owner_user_id, byte_quota)
     values ($1, $2)
     on conflict (owner_user_id) do update
     set byte_quota = greatest(drive_quota.bytes_reserved + drive_quota.bytes_stored, excluded.byte_quota)`,
    [userId, quota],
  );
}

export async function reconcileDrive(): Promise<void> {
  const { config, store } = await ready();
  const pg = await database();
  const pending = await pg.query<ObjectRow>(
    "select id, owner_user_id, byte_size, media_type, sha256, display_name, object_key, status, idempotency_key, created_at from drive_object where status in ('pending', 'deleting')",
  );
  const cutoff = Date.now() - config.staleMs;
  for (const row of pending.rows) {
    const created = new Date(row.created_at).getTime();
    if (created > cutoff) continue;
    if (row.status === "pending") {
      const onDisk = await store.exists(row.object_key);
      if (onDisk) {
        await pg.transaction(async (tx) => {
          const moved = await tx.query(
            `update drive_object set status = 'stored', stored_at = now()
             where id = $1 and status = 'pending' returning id`,
            [row.id],
          );
          if (moved.rows.length === 0) return;
          await tx.query(
            `update drive_quota
             set bytes_reserved = bytes_reserved - $2, bytes_stored = bytes_stored + $2
             where owner_user_id = $1`,
            [row.owner_user_id, row.byte_size],
          );
          await audit(tx, row.owner_user_id, "upload_stored", row.id, null);
        });
      } else {
        await pg.transaction(async (tx) => {
          const cleared = await tx.query(
            "update drive_object set status = 'aborted' where id = $1 and status = 'pending' returning id",
            [row.id],
          );
          if (cleared.rows.length === 0) return;
          await tx.query(
            "update drive_quota set bytes_reserved = bytes_reserved - $2 where owner_user_id = $1",
            [row.owner_user_id, row.byte_size],
          );
          await audit(tx, row.owner_user_id, "upload_aborted", row.id, null);
        });
      }
    } else {
      await store.remove(row.object_key);
      await finishDelete(pg, row);
    }
  }
}

async function finishDelete(
  pg: Queryable & { transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> },
  row: ObjectRow,
) {
  await pg.transaction(async (tx) => {
    const current = await tx.query<ObjectRow>(
      "select id, owner_user_id, byte_size, status, object_key from drive_object where id = $1 and status = 'deleting'",
      [row.id],
    );
    const live = current.rows[0];
    if (!live) return;
    await tx.query("update drive_object set status = 'deleted' where id = $1 and status = 'deleting'", [
      row.id,
    ]);
    await tx.query(
      `update drive_quota set
         bytes_stored = case when $3 = 'stored' then bytes_stored - $2 else bytes_stored end,
         bytes_reserved = case when $3 = 'pending' then bytes_reserved - $2 else bytes_reserved end
       where owner_user_id = $1`,
      [live.owner_user_id, live.byte_size, row.status === "pending" ? "pending" : "stored"],
    );
    await audit(tx, live.owner_user_id, "delete", live.id, null);
  });
}

export interface StoredObject {
  id: string;
  byteSize: number;
  mediaType: string;
  displayName: string;
  sha256: string;
  status: string;
  folderId: string | null;
  starred: boolean;
  trashedAt: string | null;
  versionGroup: string;
  versionNumber: number;
  isCurrent: boolean;
  previewClass: string | null;
  createdAt: string | null;
}

function present(row: ObjectRow): StoredObject {
  return {
    id: row.id,
    byteSize: row.byte_size,
    mediaType: row.media_type,
    displayName: row.display_name,
    sha256: row.sha256,
    status: row.status,
    folderId: row.folder_id ?? null,
    starred: Boolean(row.starred),
    trashedAt: row.trashed_at ? new Date(row.trashed_at).toISOString() : null,
    versionGroup: row.version_group ?? row.id,
    versionNumber: row.version_number ?? 1,
    isCurrent: row.is_current !== false,
    previewClass: row.preview_class ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

const OBJECT_COLUMNS = `id, owner_user_id, byte_size, media_type, sha256, display_name, object_key, status, idempotency_key, created_at, folder_id, trashed_at, starred, version_group, version_number, is_current, preview_class`;

async function placeObject(
  tx: Queryable,
  input: { userId: string; folderId?: string | null; versionOf?: string | null; previewClass?: string | null },
  id: string,
) {
  if (input.previewClass && !isPreviewClass(input.previewClass)) throw new DriveError(400, "bad_preview_class");
  const preview = input.previewClass ?? null;
  if (input.versionOf) {
    const prev = await tx.query<{ id: string; version_group: string | null; folder_id: string | null }>(
      `select id, version_group, folder_id from drive_object
       where id = $1 and owner_user_id = $2 and status = 'stored' and trashed_at is null`,
      [input.versionOf, input.userId],
    );
    const prior = prev.rows[0];
    if (!prior) throw new DriveError(404, "not_found");
    const group = prior.version_group ?? prior.id;
    const counted = await tx.query<{ n: number }>(
      `select count(*)::int as n from drive_object
       where owner_user_id = $1 and status in ('pending', 'stored') and (id = $2 or version_group = $2)`,
      [input.userId, group],
    );
    if ((counted.rows[0]?.n ?? 0) > 20) throw new DriveError(409, "version_limit");
    const max = await tx.query<{ n: number }>(
      `select coalesce(max(version_number), 1)::int as n from drive_object
       where owner_user_id = $1 and (id = $2 or version_group = $2)`,
      [input.userId, group],
    );
    await tx.query(
      `update drive_object set is_current = false, version_group = $2
       where owner_user_id = $1 and (id = $2 or version_group = $2)`,
      [input.userId, group],
    );
    const folderId = input.folderId === undefined ? prior.folder_id : input.folderId;
    await tx.query(
      `update drive_object
       set version_group = $2, version_number = $3, is_current = true, folder_id = $4, preview_class = $5
       where id = $1`,
      [id, group, (max.rows[0]?.n ?? 1) + 1, folderId, preview],
    );
    return;
  }
  const folderId = input.folderId ?? null;
  if (folderId) {
    const folder = await tx.query(
      "select id from drive_folder where id = $1 and owner_user_id = $2 and trashed_at is null",
      [folderId, input.userId],
    );
    if (folder.rows.length === 0) throw new DriveError(404, "not_found");
  }
  if (folderId || preview) {
    await tx.query("update drive_object set folder_id = $2, preview_class = $3 where id = $1", [
      id,
      folderId,
      preview,
    ]);
  }
}

export async function uploadObject(input: {
  userId: string;
  bytes: Uint8Array;
  mediaType: string;
  displayName: string;
  idempotencyKey: string;
  folderId?: string | null;
  versionOf?: string | null;
  previewClass?: string | null;
}): Promise<StoredObject> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)) {
    throw new DriveError(400, "bad_idempotency_key");
  }
  if (!isAllowedType(input.mediaType) || !magicMatches(input.mediaType, input.bytes)) {
    throw new DriveError(415, "type_rejected");
  }
  const { config, store } = await ready();
  if (input.bytes.byteLength > config.maxObjectBytes) throw new DriveError(413, "too_large");
  await reconcileDrive();
  const digest = sha256(input.bytes);
  const pg = await database();
  const reserved = await pg.transaction(async (tx) => {
    await ensureQuota(tx, input.userId, config.quotaBytes);
    const existing = await tx.query<ObjectRow>(
      "select id, owner_user_id, byte_size, media_type, sha256, display_name, object_key, status, idempotency_key, created_at from drive_object where owner_user_id = $1 and idempotency_key = $2 for update",
      [input.userId, input.idempotencyKey],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (prior.status === "stored" && prior.sha256 === digest) {
        return { kind: "replay" as const, object: present(prior) };
      }
      if (prior.status === "pending") throw new DriveError(409, "upload_in_progress");
      if (prior.status === "stored") throw new DriveError(409, "idempotency_conflict");
      throw new DriveError(409, "upload_aborted");
    }
    const locked = await tx.query<{ bytes_reserved: number; bytes_stored: number; byte_quota: number }>(
      "select bytes_reserved, bytes_stored, byte_quota from drive_quota where owner_user_id = $1 for update",
      [input.userId],
    );
    const quota = locked.rows[0];
    if (!quota || quota.bytes_reserved + quota.bytes_stored + input.bytes.byteLength > quota.byte_quota) {
      throw new DriveError(409, "quota_exceeded");
    }
    const id = randomUUID();
    const objectKey = newObjectKey(input.userId, id);
    await tx.query(
      `insert into drive_object
        (id, owner_user_id, byte_size, media_type, sha256, display_name, object_key, status, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
      [id, input.userId, input.bytes.byteLength, input.mediaType, digest, input.displayName, objectKey, input.idempotencyKey],
    );
    await tx.query(
      "update drive_quota set bytes_reserved = bytes_reserved + $2 where owner_user_id = $1",
      [input.userId, input.bytes.byteLength],
    );
    await placeObject(tx, input, id);
    return { kind: "new" as const, id, objectKey };
  });
  if (reserved.kind === "replay") return reserved.object;
  try {
    await store.put(reserved.objectKey, input.bytes);
  } catch (err) {
    await pg.transaction(async (tx) => {
      const cleared = await tx.query(
        "update drive_object set status = 'aborted' where id = $1 and status = 'pending' returning id",
        [reserved.id],
      );
      if (cleared.rows.length === 0) return;
      await tx.query(
        "update drive_quota set bytes_reserved = bytes_reserved - $2 where owner_user_id = $1",
        [input.userId, input.bytes.byteLength],
      );
      await audit(tx, input.userId, "upload_aborted", reserved.id, null);
    });
    await store.remove(reserved.objectKey).catch(() => undefined);
    if (err instanceof DriveError) throw err;
    throw new DriveError(500, "store_failed");
  }
  await pg.transaction(async (tx) => {
    const moved = await tx.query(
      "update drive_object set status = 'stored', stored_at = now() where id = $1 and status = 'pending' returning id",
      [reserved.id],
    );
    if (moved.rows.length === 0) return;
    await tx.query(
      "update drive_quota set bytes_reserved = bytes_reserved - $2, bytes_stored = bytes_stored + $2 where owner_user_id = $1",
      [input.userId, input.bytes.byteLength],
    );
    await audit(tx, input.userId, "upload_stored", reserved.id, null);
  });
  return {
    id: reserved.id,
    byteSize: input.bytes.byteLength,
    mediaType: input.mediaType,
    displayName: input.displayName,
    sha256: digest,
    status: "stored",
    folderId: input.folderId ?? null,
    starred: false,
    trashedAt: null,
    versionGroup: input.versionOf ?? reserved.id,
    versionNumber: input.versionOf ? 2 : 1,
    isCurrent: true,
    previewClass: input.previewClass ?? null,
    createdAt: new Date().toISOString(),
  };
}

export interface ListFilter {
  trash?: boolean;
  starred?: boolean;
  photos?: boolean;
  rooted?: boolean;
  folderId?: string | null;
  query?: string;
}

export async function listObjects(userId: string, filter: ListFilter = {}): Promise<StoredObject[]> {
  await ready();
  const pg = await database();
  const trash = filter.trash === true;
  const params: unknown[] = [userId, trash];
  let sql = `select ${OBJECT_COLUMNS.split(", ").map((column) => `o.${column}`).join(", ")}
     from drive_object o
     left join drive_folder f on f.id = o.folder_id
     where o.owner_user_id = $1 and o.status in ('pending', 'stored') and o.is_current = true
       and (
         ($2::boolean = true and (o.trashed_at is not null or f.trashed_at is not null))
         or ($2::boolean = false and o.trashed_at is null and f.trashed_at is null)
       )`;
  if (filter.starred) sql += " and o.starred = true";
  if (filter.photos) sql += " and (o.preview_class = 'image' or o.media_type like 'image/%')";
  if (filter.rooted) {
    params.push(filter.folderId ?? null);
    sql += ` and o.folder_id is not distinct from $${params.length}`;
  }
  if (filter.query) {
    const cleaned = filter.query.replace(/[%_\\]/g, "").trim().slice(0, 80);
    if (cleaned) {
      params.push(`%${cleaned}%`);
      sql += ` and o.display_name ilike $${params.length} and o.display_name not like 'cmls1.%'`;
    }
  }
  sql += " order by o.created_at desc";
  const rows = await pg.query<ObjectRow>(sql, params);
  return rows.rows.map(present);
}

export async function readObject(userId: string, objectId: string): Promise<{ meta: StoredObject; bytes: Uint8Array }> {
  const { store } = await ready();
  const pg = await database();
  const found = await pg.query<ObjectRow>(
    `select ${OBJECT_COLUMNS}
     from drive_object where id = $1 and owner_user_id = $2 and status = 'stored'`,
    [objectId, userId],
  );
  let row: ObjectRow | undefined = found.rows[0];
  if (!row) row = await grantedObject(pg, userId, objectId);
  if (!row) throw new DriveError(404, "not_found");
  const bytes = await store.get(row.object_key);
  await audit(pg, userId, "download", row.id, null);
  return { meta: present(row), bytes };
}

export async function deleteObject(userId: string, objectId: string): Promise<void> {
  const { store } = await ready();
  const pg = await database();
  const claimed = await pg.transaction(async (tx) => {
    const found = await tx.query<ObjectRow>(
      `select id, owner_user_id, byte_size, media_type, sha256, display_name, object_key, status, idempotency_key, created_at
       from drive_object where id = $1 and owner_user_id = $2 and status in ('pending', 'stored', 'deleting')
       for update`,
      [objectId, userId],
    );
    const row = found.rows[0];
    if (!row) throw new DriveError(404, "not_found");
    if (row.status !== "deleting") {
      await tx.query("update drive_object set status = 'deleting' where id = $1", [row.id]);
    }
    await tx.query("update drive_share set revoked_at = now() where object_id = $1 and revoked_at is null", [
      row.id,
    ]);
    return row;
  });
  await store.remove(claimed.object_key);
  await finishDelete(pg, { ...claimed, status: claimed.status === "deleting" ? "stored" : claimed.status });
}

export async function createShare(input: {
  userId: string;
  objectId: string;
  consent: boolean;
  expiresInSeconds: number;
  password?: string;
  maxDownloads?: number | null;
}): Promise<{ id: string; token: string; expiresAt: string; hasPassword: boolean; maxDownloads: number | null }> {
  if (input.consent !== true) throw new DriveError(400, "consent_required");
  if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 60 || input.expiresInSeconds > 604800) {
    throw new DriveError(400, "bad_expiry");
  }
  await ready();
  const pg = await database();
  const token = randomBytes(32).toString("base64url");
  const hash = tokenHash(token);
  const shareId = randomUUID();
  const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000).toISOString();
  let passwordHash: string | null = null;
  if (input.password) {
    if (input.password.length < 4 || input.password.length > 128) throw new DriveError(400, "bad_password");
    passwordHash = await hashSharePassword(input.password);
  }
  let maxDownloads: number | null = null;
  if (input.maxDownloads != null) {
    if (!Number.isInteger(input.maxDownloads) || input.maxDownloads < 1 || input.maxDownloads > 10000) {
      throw new DriveError(400, "bad_download_limit");
    }
    maxDownloads = input.maxDownloads;
  }
  await pg.transaction(async (tx) => {
    const found = await tx.query(
      "select id from drive_object where id = $1 and owner_user_id = $2 and status = 'stored'",
      [input.objectId, input.userId],
    );
    if (found.rows.length === 0) throw new DriveError(404, "not_found");
    await tx.query(
      `insert into drive_share (id, object_id, owner_user_id, token_hash, expires_at, password_hash, max_downloads)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [shareId, input.objectId, input.userId, hash, expiresAt, passwordHash, maxDownloads],
    );
    await audit(tx, input.userId, "share_create", input.objectId, shareId);
  });
  return { id: shareId, token, expiresAt, hasPassword: passwordHash !== null, maxDownloads };
}

export async function revokeShare(userId: string, shareId: string): Promise<void> {
  await ready();
  const pg = await database();
  const updated = await pg.query<{ object_id: string }>(
    `update drive_share set revoked_at = now()
     where id = $1 and owner_user_id = $2 and revoked_at is null
     returning object_id`,
    [shareId, userId],
  );
  const row = updated.rows[0];
  if (!row) {
    const own = await pg.query(
      "select id from drive_share where id = $1 and owner_user_id = $2",
      [shareId, userId],
    );
    if (own.rows.length === 0) throw new DriveError(404, "not_found");
    return;
  }
  await audit(pg, userId, "share_revoke", row.object_id, shareId);
}

export async function listShares(userId: string, objectId: string) {
  await ready();
  const pg = await database();
  const owned = await pg.query(
    "select id from drive_object where id = $1 and owner_user_id = $2",
    [objectId, userId],
  );
  if (owned.rows.length === 0) throw new DriveError(404, "not_found");
  const shares = await pg.query<{
    id: string;
    expires_at: string | Date;
    revoked_at: string | Date | null;
    password_hash: string | null;
    max_downloads: number | null;
    download_count: number;
  }>(
    `select id, expires_at, revoked_at, password_hash, max_downloads, download_count from drive_share
     where object_id = $1 and owner_user_id = $2 order by created_at desc`,
    [objectId, userId],
  );
  return shares.rows.map((share) => ({
    id: share.id,
    expiresAt: new Date(share.expires_at).toISOString(),
    revokedAt: share.revoked_at ? new Date(share.revoked_at).toISOString() : null,
    hasPassword: Boolean(share.password_hash),
    maxDownloads: share.max_downloads,
    downloadCount: share.download_count,
  }));
}

export async function readShared(token: string, password?: string): Promise<{ meta: StoredObject; bytes: Uint8Array }> {
  if (!token || token.length < 20) throw new DriveError(404, "not_found");
  const { store } = await ready();
  const pg = await database();
  const found = await pg.query<
    ObjectRow & { share_id: string; password_hash: string | null; max_downloads: number | null; download_count: number }
  >(
    `select o.id, o.owner_user_id, o.byte_size, o.media_type, o.sha256, o.display_name, o.object_key,
            o.status, o.idempotency_key, o.created_at, s.id as share_id, s.password_hash, s.max_downloads, s.download_count
     from drive_share s
     join drive_object o on o.id = s.object_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and o.status = 'stored'`,
    [tokenHash(token)],
  );
  const row = found.rows[0];
  if (!row) throw new DriveError(404, "not_found");
  if (row.password_hash) {
    if (!password || !(await passwordMatches(password, row.password_hash))) {
      throw new DriveError(401, "password_required");
    }
  }
  if (row.max_downloads != null && row.download_count >= row.max_downloads) {
    throw new DriveError(403, "download_limit");
  }
  await pg.query("update drive_share set download_count = download_count + 1 where id = $1", [row.share_id]);
  const bytes = await store.get(row.object_key);
  await audit(pg, row.owner_user_id, "share_download", row.id, row.share_id);
  return { meta: present(row), bytes };
}

export async function quotaFor(userId: string): Promise<{ quotaBytes: number; bytesReserved: number; bytesStored: number }> {
  const { config } = await ready();
  const pg = await database();
  await ensureQuota(pg, userId, config.quotaBytes);
  const rows = await pg.query<{ byte_quota: number; bytes_reserved: number; bytes_stored: number }>(
    "select byte_quota, bytes_reserved, bytes_stored from drive_quota where owner_user_id = $1",
    [userId],
  );
  const row = rows.rows[0];
  return {
    quotaBytes: row?.byte_quota ?? config.quotaBytes,
    bytesReserved: row?.bytes_reserved ?? 0,
    bytesStored: row?.bytes_stored ?? 0,
  };
}

export async function closeDrive(): Promise<void> {
  readyPromise = null;
  await closeDb();
}

async function grantedObject(db: Queryable, userId: string, objectId: string): Promise<ObjectRow | undefined> {
  const user = await db.query<{ email: string }>(`select "email" as email from "user" where "id" = $1`, [userId]);
  const identity = await db.query<{ cid: string }>("select cid from drive_identity where user_id = $1", [userId]);
  const email = user.rows[0]?.email ?? "";
  const cid = identity.rows[0]?.cid ?? "";
  const found = await db.query<ObjectRow>(
    `select ${OBJECT_COLUMNS.split(", ").map((column) => `o.${column}`).join(", ")}
     from drive_object o
     join drive_grant g on (g.object_id = o.id or (g.folder_id is not null and g.folder_id = o.folder_id))
     where o.id = $1 and o.status = 'stored' and o.trashed_at is null and g.revoked_at is null
       and (g.grantee_user_id = $2 or ($3 <> '' and g.grantee_label = $3) or ($4 <> '' and g.grantee_label = $4))`,
    [objectId, userId, email, cid],
  );
  return found.rows[0];
}

function hashSharePassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) reject(err);
      else resolve(`scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`);
    });
  });
}

async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
  if (expected.length !== key.length) return false;
  return timingSafeEqual(expected, key);
}

export type { AllowedType };
