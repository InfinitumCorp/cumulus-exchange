import { createHash } from "node:crypto";

/**
 * Provider-neutral byte store. Upload, download, delete, share, and quota
 * talk to this interface only.
 *
 * The free implementation is the local filesystem. A later S3 or R2 adapter
 * can implement the same four methods. Switching adapters does not rewrite
 * those callers, but bytes already on disk still have to be copied and the
 * process config changed. That move is a migration, not a free rename.
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

const KEY =
  /^drive\/[0-9a-f]{64}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertObjectKey(key: string): void {
  if (!KEY.test(key)) throw new Error("object_key_rejected");
}

export function newObjectKey(userId: string, objectId: string): string {
  const userHash = createHash("sha256").update(userId).digest("hex");
  const key = `drive/${userHash}/${objectId}`;
  assertObjectKey(key);
  return key;
}
