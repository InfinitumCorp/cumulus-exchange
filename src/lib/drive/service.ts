import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeDb, getPglite, getSql } from "@/lib/db";
import { newObjectKey, type BlobStore } from "@/lib/drive/blob-store";
import { readDriveConfig, type DriveConfig } from "@/lib/drive/config";
import { DriveError } from "@/lib/drive/errors";
import { localBlobStore, prepareBlobRoot } from "@/lib/drive/local-blob";
import { isAllowedType, magicMatches, type AllowedType } from "@/lib/drive/magic";

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
}

function present(row: ObjectRow): StoredObject {
  return {
    id: row.id,
    byteSize: row.byte_size,
    mediaType: row.media_type,
    displayName: row.display_name,
    sha256: row.sha256,
    status: row.status,
  };
}

export async function uploadObject(input: {
  userId: string;
  bytes: Uint8Array;
  mediaType: string;
  displayName: string;
  idempotencyKey: string;
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
  };
}

export async function listObjects(userId: string): Promise<StoredObject[]> {
  await ready();
  const pg = await database();
  const rows = await pg.query<ObjectRow>(
    `select id, owner_user_id, byte_size, media_type, sha256, display_name, object_key, status, idempotency_key, created_at
     from drive_object where owner_user_id = $1 and status in ('pending', 'stored')
     order by created_at desc`,
    [userId],
  );
  return rows.rows.map(present);
}

export async function readObject(userId: string, objectId: string): Promise<{ meta: StoredObject; bytes: Uint8Array }> {
  const { store } = await ready();
  const pg = await database();
  const found = await pg.query<ObjectRow>(
    `select id, owner_user_id, byte_size, media_type, sha256, display_name, object_key, status, idempotency_key, created_at
     from drive_object where id = $1 and owner_user_id = $2 and status = 'stored'`,
    [objectId, userId],
  );
  const row = found.rows[0];
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
}): Promise<{ id: string; token: string; expiresAt: string }> {
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
  await pg.transaction(async (tx) => {
    const found = await tx.query(
      "select id from drive_object where id = $1 and owner_user_id = $2 and status = 'stored'",
      [input.objectId, input.userId],
    );
    if (found.rows.length === 0) throw new DriveError(404, "not_found");
    await tx.query(
      `insert into drive_share (id, object_id, owner_user_id, token_hash, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [shareId, input.objectId, input.userId, hash, expiresAt],
    );
    await audit(tx, input.userId, "share_create", input.objectId, shareId);
  });
  return { id: shareId, token, expiresAt };
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
  const shares = await pg.query<{ id: string; expires_at: string | Date; revoked_at: string | Date | null }>(
    `select id, expires_at, revoked_at from drive_share
     where object_id = $1 and owner_user_id = $2 order by created_at desc`,
    [objectId, userId],
  );
  return shares.rows.map((share) => ({
    id: share.id,
    expiresAt: new Date(share.expires_at).toISOString(),
    revokedAt: share.revoked_at ? new Date(share.revoked_at).toISOString() : null,
  }));
}

export async function readShared(token: string): Promise<{ meta: StoredObject; bytes: Uint8Array }> {
  if (!token || token.length < 20) throw new DriveError(404, "not_found");
  const { store } = await ready();
  const pg = await database();
  const found = await pg.query<ObjectRow & { share_id: string }>(
    `select o.id, o.owner_user_id, o.byte_size, o.media_type, o.sha256, o.display_name, o.object_key,
            o.status, o.idempotency_key, o.created_at, s.id as share_id
     from drive_share s
     join drive_object o on o.id = s.object_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and o.status = 'stored'`,
    [tokenHash(token)],
  );
  const row = found.rows[0];
  if (!row) throw new DriveError(404, "not_found");
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

export type { AllowedType };
