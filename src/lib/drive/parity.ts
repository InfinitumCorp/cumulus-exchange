import { randomUUID } from "node:crypto";
import { getPglite } from "@/lib/db";
import { newObjectKey } from "@/lib/drive/blob-store";
import { readDriveConfig } from "@/lib/drive/config";
import { DriveError } from "@/lib/drive/errors";
import { localBlobStore, prepareBlobRoot } from "@/lib/drive/local-blob";
import { acceptDisplayName } from "@/lib/drive/magic";
import { isPreviewClass, type PreviewClass } from "@/lib/drive/preview-class";
import { accountSecurityStatus } from "@/lib/drive/account-security";
import { syncDesign } from "@/lib/drive/sync-design";
import {
  createShare,
  deleteObject,
  readObject,
  uploadObject,
  type StoredObject,
} from "@/lib/drive/service";

type Row = Record<string, unknown>;

interface Queryable {
  query<T = Row>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CID = /^cid_[a-z0-9_]{1,64}$/;

async function db(): Promise<Queryable & { transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> }> {
  return getPglite();
}

async function audit(actor: string, action: string, objectId: string | null) {
  const pg = await db();
  await pg.query(
    "insert into drive_audit (id, actor_user_id, action, object_id, share_id) values ($1, $2, $3, $4, null)",
    [randomUUID(), actor, action, objectId],
  );
}

function requireUuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new DriveError(400, code);
  return value;
}

export interface DriveFolder {
  id: string;
  parentId: string | null;
  displayName: string;
  trashedAt: string | null;
}

export async function listFolders(userId: string, filter: { trash?: boolean; parentId?: string | null; rooted?: boolean }): Promise<DriveFolder[]> {
  const pg = await db();
  const params: unknown[] = [userId, filter.trash === true];
  let sql = `select id, parent_id, display_name, trashed_at from drive_folder
    where owner_user_id = $1 and (($2::boolean = true and trashed_at is not null) or ($2::boolean = false and trashed_at is null))`;
  if (filter.rooted) {
    params.push(filter.parentId ?? null);
    sql += ` and parent_id is not distinct from $${params.length}`;
  }
  sql += " order by created_at desc";
  const rows = await pg.query<{ id: string; parent_id: string | null; display_name: string; trashed_at: string | Date | null }>(sql, params);
  return rows.rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    displayName: row.display_name,
    trashedAt: row.trashed_at ? new Date(row.trashed_at).toISOString() : null,
  }));
}

export async function createFolder(userId: string, name: string, parentId: string | null): Promise<DriveFolder> {
  const displayName = acceptDisplayName(name);
  const pg = await db();
  if (parentId) {
    const parent = await pg.query(
      "select id from drive_folder where id = $1 and owner_user_id = $2 and trashed_at is null",
      [parentId, userId],
    );
    if (parent.rows.length === 0) throw new DriveError(404, "not_found");
  }
  const id = randomUUID();
  await pg.query(
    "insert into drive_folder (id, owner_user_id, parent_id, display_name) values ($1, $2, $3, $4)",
    [id, userId, parentId, displayName],
  );
  return { id, parentId, displayName, trashedAt: null };
}

export async function trashObject(userId: string, objectId: string): Promise<void> {
  const pg = await db();
  const updated = await pg.query(
    `update drive_object set trashed_at = now()
     where id = $1 and owner_user_id = $2 and status = 'stored' and trashed_at is null
     returning id`,
    [objectId, userId],
  );
  if (updated.rows.length === 0) {
    const folder = await pg.query(
      `update drive_folder set trashed_at = now()
       where id = $1 and owner_user_id = $2 and trashed_at is null returning id`,
      [objectId, userId],
    );
    if (folder.rows.length === 0) throw new DriveError(404, "not_found");
  }
  await audit(userId, "trash", objectId);
}

export async function restoreObject(userId: string, objectId: string): Promise<void> {
  const pg = await db();
  const updated = await pg.query(
    `update drive_object set trashed_at = null
     where id = $1 and owner_user_id = $2 and trashed_at is not null returning id`,
    [objectId, userId],
  );
  if (updated.rows.length === 0) {
    const folder = await pg.query(
      `update drive_folder set trashed_at = null
       where id = $1 and owner_user_id = $2 and trashed_at is not null returning id`,
      [objectId, userId],
    );
    if (folder.rows.length === 0) throw new DriveError(404, "not_found");
  }
  await audit(userId, "restore", objectId);
}

export async function setStar(userId: string, objectId: string, starred: boolean): Promise<void> {
  const pg = await db();
  const updated = await pg.query(
    "update drive_object set starred = $3 where id = $1 and owner_user_id = $2 and status = 'stored' returning id",
    [objectId, userId, starred],
  );
  if (updated.rows.length === 0) throw new DriveError(404, "not_found");
  await audit(userId, "star", objectId);
}

export async function listVersions(userId: string, objectId: string): Promise<StoredObject[]> {
  const pg = await db();
  const seed = await pg.query<{ version_group: string | null }>(
    "select version_group from drive_object where id = $1 and owner_user_id = $2",
    [objectId, userId],
  );
  const row = seed.rows[0];
  if (!row) throw new DriveError(404, "not_found");
  const group = row.version_group ?? objectId;
  const rows = await pg.query<{
    id: string;
    byte_size: number;
    media_type: string;
    display_name: string;
    sha256: string;
    status: string;
    folder_id: string | null;
    trashed_at: string | Date | null;
    starred: boolean;
    version_group: string | null;
    version_number: number;
    is_current: boolean;
    preview_class: string | null;
    created_at: string | Date;
  }>(
    `select id, byte_size, media_type, display_name, sha256, status, folder_id, trashed_at, starred,
            version_group, version_number, is_current, preview_class, created_at
     from drive_object
     where owner_user_id = $1 and status in ('pending', 'stored') and (id = $2 or version_group = $2)
     order by version_number desc`,
    [userId, group],
  );
  return rows.rows.map((item) => ({
    id: item.id,
    byteSize: item.byte_size,
    mediaType: item.media_type,
    displayName: item.display_name,
    sha256: item.sha256,
    status: item.status,
    folderId: item.folder_id,
    starred: Boolean(item.starred),
    trashedAt: item.trashed_at ? new Date(item.trashed_at).toISOString() : null,
    versionGroup: item.version_group ?? item.id,
    versionNumber: item.version_number,
    isCurrent: item.is_current,
    previewClass: item.preview_class,
    createdAt: new Date(item.created_at).toISOString(),
  }));
}

export async function restoreVersion(userId: string, objectId: string): Promise<void> {
  const pg = await db();
  await pg.transaction(async (tx) => {
    const found = await tx.query<{ version_group: string | null }>(
      "select version_group from drive_object where id = $1 and owner_user_id = $2 and status = 'stored'",
      [objectId, userId],
    );
    const row = found.rows[0];
    if (!row) throw new DriveError(404, "not_found");
    const group = row.version_group ?? objectId;
    await tx.query(
      "update drive_object set is_current = false where owner_user_id = $1 and (id = $2 or version_group = $2)",
      [userId, group],
    );
    await tx.query("update drive_object set is_current = true, trashed_at = null where id = $1", [objectId]);
  });
  await audit(userId, "version_restore", objectId);
}

async function labelsFor(userId: string): Promise<{ email: string; cid: string }> {
  const pg = await db();
  const user = await pg.query<{ email: string }>(`select "email" as email from "user" where "id" = $1`, [userId]);
  const identity = await pg.query<{ cid: string }>("select cid from drive_identity where user_id = $1", [userId]);
  return { email: user.rows[0]?.email ?? "", cid: identity.rows[0]?.cid ?? "" };
}

export async function createGrant(input: {
  userId: string;
  objectId?: string | null;
  folderId?: string | null;
  grantee: string;
  role: string;
}): Promise<{ id: string; role: string; grantee: string; pending: boolean }> {
  if (input.role !== "viewer" && input.role !== "editor") throw new DriveError(400, "bad_role");
  const grantee = input.grantee.trim();
  if (!grantee || grantee.length > 200) throw new DriveError(400, "bad_grantee");
  if (!input.objectId && !input.folderId) throw new DriveError(400, "bad_target");
  const pg = await db();
  const owner = await labelsFor(input.userId);
  if (grantee === owner.email || grantee === owner.cid) throw new DriveError(400, "bad_grantee");
  if (input.objectId) {
    const owned = await pg.query(
      "select id from drive_object where id = $1 and owner_user_id = $2 and status = 'stored'",
      [input.objectId, input.userId],
    );
    if (owned.rows.length === 0) throw new DriveError(404, "not_found");
  }
  if (input.folderId) {
    const owned = await pg.query(
      "select id from drive_folder where id = $1 and owner_user_id = $2 and trashed_at is null",
      [input.folderId, input.userId],
    );
    if (owned.rows.length === 0) throw new DriveError(404, "not_found");
  }
  const match = CID.test(grantee)
    ? await pg.query<{ user_id: string }>("select user_id from drive_identity where cid = $1", [grantee])
    : await pg.query<{ id: string }>(`select "id" as id from "user" where lower("email") = lower($1)`, [grantee]);
  const granteeUserId = CID.test(grantee)
    ? (match.rows[0] as { user_id?: string } | undefined)?.user_id ?? null
    : (match.rows[0] as { id?: string } | undefined)?.id ?? null;
  const id = randomUUID();
  await pg.query(
    `insert into drive_grant (id, object_id, folder_id, owner_user_id, grantee_user_id, grantee_label, role)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.objectId ?? null, input.folderId ?? null, input.userId, granteeUserId, grantee, input.role],
  );
  await audit(input.userId, "grant_create", input.objectId ?? input.folderId ?? null);
  return { id, role: input.role, grantee, pending: granteeUserId === null };
}

export async function revokeGrant(userId: string, grantId: string): Promise<void> {
  const pg = await db();
  const updated = await pg.query(
    "update drive_grant set revoked_at = now() where id = $1 and owner_user_id = $2 and revoked_at is null returning id",
    [grantId, userId],
  );
  if (updated.rows.length === 0) throw new DriveError(404, "not_found");
  await audit(userId, "grant_revoke", null);
}

export async function listSharedWithMe(userId: string) {
  const pg = await db();
  const who = await labelsFor(userId);
  const rows = await pg.query<{
    id: string;
    object_id: string | null;
    folder_id: string | null;
    role: string;
    grantee_label: string;
    display_name: string | null;
  }>(
    `select g.id, g.object_id, g.folder_id, g.role, g.grantee_label, o.display_name
     from drive_grant g
     left join drive_object o on o.id = g.object_id
     where g.revoked_at is null
       and (g.grantee_user_id = $1 or ($2 <> '' and g.grantee_label = $2) or ($3 <> '' and g.grantee_label = $3))
     order by g.created_at desc`,
    [userId, who.email, who.cid],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    objectId: row.object_id,
    folderId: row.folder_id,
    role: row.role,
    grantee: row.grantee_label,
    displayName: row.display_name,
  }));
}

export async function setIdentity(userId: string, cid: string): Promise<{ cid: string }> {
  if (!CID.test(cid)) throw new DriveError(400, "bad_cid");
  const pg = await db();
  await pg.query(
    `insert into drive_identity (user_id, cid) values ($1, $2)
     on conflict (user_id) do update set cid = excluded.cid`,
    [userId, cid],
  );
  return { cid };
}

export async function listAudit(userId: string) {
  const pg = await db();
  const rows = await pg.query<{ id: string; action: string; object_id: string | null; at: string | Date }>(
    `select id, action, object_id, at from drive_audit
     where actor_user_id = $1 order by at desc limit 50`,
    [userId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    action: row.action,
    objectId: row.object_id,
    at: new Date(row.at).toISOString(),
  }));
}

export async function listSessions(userId: string, currentToken: string | null) {
  const pg = await db();
  const rows = await pg.query<{ id: string; createdAt: string | Date; expiresAt: string | Date; userAgent: string | null; token: string }>(
    `select "id", "createdAt", "expiresAt", "userAgent", "token" from "session" where "userId" = $1 order by "createdAt" desc`,
    [userId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    userAgent: row.userAgent,
    current: currentToken !== null && row.token === currentToken,
  }));
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const pg = await db();
  const updated = await pg.query(`delete from "session" where "id" = $1 and "userId" = $2 returning "id"`, [
    sessionId,
    userId,
  ]);
  if (updated.rows.length === 0) throw new DriveError(404, "not_found");
}

export async function mailHandoff(input: {
  userId: string;
  objectId: string;
  consent: boolean;
  expiresInSeconds: number;
}): Promise<{ status: "deferred"; channel: "cumulus-mail"; reason: string; share: { id: string; token: string; expiresAt: string } }> {
  const share = await createShare(input);
  const pg = await db();
  await pg.query(
    "insert into drive_audit (id, actor_user_id, action, object_id, share_id) values ($1, $2, 'mail_handoff', $3, $4)",
    [randomUUID(), input.userId, input.objectId, share.id],
  );
  return {
    status: "deferred",
    channel: "cumulus-mail",
    reason: "Mail delivery is another repository. This returns an expiring share link and does not send a message.",
    share,
  };
}

async function blobStore() {
  const config = await readDriveConfig();
  const root = await prepareBlobRoot(config.blobRoot);
  return { config, store: localBlobStore(root) };
}

export async function beginUpload(input: {
  userId: string;
  mediaType: string;
  displayName: string;
  totalBytes: number;
  partSize: number;
  idempotencyKey: string;
  folderId?: string | null;
  versionOf?: string | null;
  previewClass?: string | null;
}): Promise<{ uploadId: string; partsExpected: number }> {
  if (!UUID.test(input.idempotencyKey)) throw new DriveError(400, "bad_idempotency_key");
  if (!Number.isInteger(input.totalBytes) || input.totalBytes < 1) throw new DriveError(400, "bad_upload");
  if (!Number.isInteger(input.partSize) || input.partSize < 1 || input.partSize > input.totalBytes) {
    throw new DriveError(400, "bad_upload");
  }
  const { config } = await blobStore();
  if (input.totalBytes > config.maxObjectBytes) throw new DriveError(413, "too_large");
  if (input.previewClass && !isPreviewClass(input.previewClass)) throw new DriveError(400, "bad_preview_class");
  const partsExpected = Math.ceil(input.totalBytes / input.partSize);
  const pg = await db();
  const existing = await pg.query<{ id: string; parts_expected: number; status: string }>(
    "select id, parts_expected, status from drive_upload where owner_user_id = $1 and idempotency_key = $2",
    [input.userId, input.idempotencyKey],
  );
  const prior = existing.rows[0];
  if (prior) {
    if (prior.status === "aborted") throw new DriveError(409, "upload_aborted");
    return { uploadId: prior.id, partsExpected: prior.parts_expected };
  }
  const uploadId = randomUUID();
  await pg.query(
    `insert into drive_upload
      (id, owner_user_id, media_type, display_name, total_bytes, part_size, parts_expected, idempotency_key, folder_id, version_of, preview_class, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open')`,
    [
      uploadId,
      input.userId,
      input.mediaType,
      acceptDisplayName(input.displayName),
      input.totalBytes,
      input.partSize,
      partsExpected,
      input.idempotencyKey,
      input.folderId ?? null,
      input.versionOf ?? null,
      input.previewClass ?? null,
    ],
  );
  return { uploadId, partsExpected };
}

export async function writeUploadPart(input: {
  userId: string;
  uploadId: string;
  partNumber: number;
  bytes: Uint8Array;
}): Promise<void> {
  if (!Number.isInteger(input.partNumber) || input.partNumber < 1) throw new DriveError(400, "bad_part");
  const pg = await db();
  const upload = await pg.query<{ part_size: number; parts_expected: number; total_bytes: number; status: string }>(
    "select part_size, parts_expected, total_bytes, status from drive_upload where id = $1 and owner_user_id = $2",
    [input.uploadId, input.userId],
  );
  const row = upload.rows[0];
  if (!row || row.status !== "open") throw new DriveError(404, "not_found");
  if (input.partNumber > row.parts_expected) throw new DriveError(400, "bad_part");
  const last = input.partNumber === row.parts_expected;
  const expected = last ? row.total_bytes - row.part_size * (row.parts_expected - 1) : row.part_size;
  if (input.bytes.byteLength !== expected) throw new DriveError(400, "bad_part");
  const { store } = await blobStore();
  const partId = randomUUID();
  const objectKey = newObjectKey(input.userId, partId);
  await store.put(objectKey, input.bytes);
  try {
    await pg.query(
      `insert into drive_upload_part (upload_id, part_number, byte_size, object_key) values ($1, $2, $3, $4)
       on conflict (upload_id, part_number) do update set byte_size = excluded.byte_size, object_key = excluded.object_key`,
      [input.uploadId, input.partNumber, input.bytes.byteLength, objectKey],
    );
  } catch (err) {
    await store.remove(objectKey).catch(() => undefined);
    throw err;
  }
  await audit(input.userId, "upload_part", null);
}

export async function completeUpload(userId: string, uploadId: string): Promise<StoredObject> {
  const pg = await db();
  const upload = await pg.query<{
    media_type: string;
    display_name: string;
    total_bytes: number;
    parts_expected: number;
    idempotency_key: string;
    folder_id: string | null;
    version_of: string | null;
    preview_class: string | null;
    status: string;
    object_id: string | null;
  }>(
    `select media_type, display_name, total_bytes, parts_expected, idempotency_key, folder_id, version_of, preview_class, status, object_id
     from drive_upload where id = $1 and owner_user_id = $2`,
    [uploadId, userId],
  );
  const row = upload.rows[0];
  if (!row) throw new DriveError(404, "not_found");
  if (row.status === "complete" && row.object_id) {
    const existing = await readObject(userId, row.object_id);
    return existing.meta;
  }
  if (row.status !== "open") throw new DriveError(409, "upload_aborted");
  const parts = await pg.query<{ part_number: number; object_key: string }>(
    "select part_number, object_key from drive_upload_part where upload_id = $1 order by part_number",
    [uploadId],
  );
  if (parts.rows.length !== row.parts_expected) throw new DriveError(409, "upload_incomplete");
  const { store } = await blobStore();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const part of parts.rows) {
    const bytes = await store.get(part.object_key);
    chunks.push(bytes);
    total += bytes.byteLength;
  }
  if (total !== row.total_bytes) throw new DriveError(409, "upload_incomplete");
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const stored = await uploadObject({
    userId,
    bytes: body,
    mediaType: row.media_type,
    displayName: row.display_name,
    idempotencyKey: row.idempotency_key,
    folderId: row.folder_id,
    versionOf: row.version_of,
    previewClass: row.preview_class as PreviewClass | null,
  });
  await pg.query("update drive_upload set status = 'complete', object_id = $2 where id = $1", [uploadId, stored.id]);
  for (const part of parts.rows) await store.remove(part.object_key).catch(() => undefined);
  return stored;
}

export async function editorVersion(input: {
  userId: string;
  objectId: string;
  bytes: Uint8Array;
  mediaType: string;
  displayName: string;
  idempotencyKey: string;
  previewClass?: string | null;
}): Promise<StoredObject> {
  const pg = await db();
  const who = await labelsFor(input.userId);
  const grant = await pg.query<{ owner_user_id: string }>(
    `select g.owner_user_id from drive_grant g
     join drive_object o on o.id = g.object_id or o.folder_id = g.folder_id
     where o.id = $1 and g.role = 'editor' and g.revoked_at is null
       and (g.grantee_user_id = $2 or ($3 <> '' and g.grantee_label = $3) or ($4 <> '' and g.grantee_label = $4))`,
    [input.objectId, input.userId, who.email, who.cid],
  );
  const owner = grant.rows[0]?.owner_user_id;
  if (!owner) throw new DriveError(404, "not_found");
  return uploadObject({
    userId: owner,
    bytes: input.bytes,
    mediaType: input.mediaType,
    displayName: acceptDisplayName(input.displayName),
    idempotencyKey: input.idempotencyKey,
    versionOf: input.objectId,
    previewClass: input.previewClass,
  });
}

export function securityReport() {
  return { ...accountSecurityStatus(), sync: syncDesign() };
}

export async function purgeOwned(userId: string, objectId: string): Promise<void> {
  const pg = await db();
  const folder = await pg.query(
    "select id from drive_folder where id = $1 and owner_user_id = $2",
    [objectId, userId],
  );
  if (folder.rows.length > 0) {
    const files = await pg.query<{ id: string }>(
      "select id from drive_object where folder_id = $1 and owner_user_id = $2 and status in ('pending', 'stored')",
      [objectId, userId],
    );
    for (const file of files.rows) await deleteObject(userId, file.id);
    await pg.query("delete from drive_folder where id = $1 and owner_user_id = $2", [objectId, userId]);
    return;
  }
  await deleteObject(userId, objectId);
}
