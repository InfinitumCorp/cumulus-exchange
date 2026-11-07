import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { atomicWrite } from "./atomic.mjs";
import { assertLoopbackEndpoint, assertNotLiveSupabase } from "./guard.mjs";

const TENANT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const BLOB_ID = /^[a-f0-9]{32}$/;

function assertIds(tenantId, blobId) {
  if (!TENANT_ID.test(tenantId)) throw new Error("Unsafe tenant id");
  if (!BLOB_ID.test(blobId)) throw new Error("Unsafe blob id");
}

/**
 * Primary driver. Bytes live on disk under tenants/<tenantId>/<blobId>.
 * Writes are atomic. The service checks the SHA-256 against metadata.
 * @param {string} root
 */
export function createFilesystemDriver(root) {
  const base = path.resolve(root);
  function location(tenantId, blobId) {
    assertIds(tenantId, blobId);
    const full = path.resolve(base, "tenants", tenantId, blobId);
    const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
    if (!full.startsWith(prefix)) throw new Error("Blob path escaped the data directory");
    return full;
  }
  return {
    kind: "filesystem",
    async put(tenantId, blobId, bytes) {
      await atomicWrite(location(tenantId, blobId), bytes);
    },
    async get(tenantId, blobId) {
      return readFile(location(tenantId, blobId));
    },
    async delete(tenantId, blobId) {
      await rm(location(tenantId, blobId), { force: true });
    },
    async probe() {
      const blobId = "aa".padEnd(32, "0");
      await this.put("probe", blobId, Buffer.from("probe"));
      const got = await this.get("probe", blobId);
      await this.delete("probe", blobId);
      return got.toString() === "probe";
    },
  };
}

/**
 * Swap-in S3 driver (R2, B2, S3, or Supabase Storage later).
 * Container tests must pass a loopback endpoint. The live Supabase project is refused
 * unless CUMULUS_ALLOW_SUPABASE is set, which this repository never sets.
 */
export function createS3Driver(options) {
  assertNotLiveSupabase(options.endpoint);
  if (options.loopbackOnly) assertLoopbackEndpoint(options.endpoint);
  const client = new S3Client({
    region: options.region || "us-east-1",
    endpoint: options.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const bucket = options.bucket;
  return {
    kind: "s3",
    client,
    bucket,
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    },
    async put(tenantId, blobId, bytes) {
      assertIds(tenantId, blobId);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `tenants/${tenantId}/${blobId}`,
          Body: bytes,
        }),
      );
    },
    async get(tenantId, blobId) {
      assertIds(tenantId, blobId);
      const out = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: `tenants/${tenantId}/${blobId}`,
        }),
      );
      return Buffer.from(await out.Body.transformToByteArray());
    },
    async delete(tenantId, blobId) {
      assertIds(tenantId, blobId);
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: `tenants/${tenantId}/${blobId}`,
        }),
      );
    },
    async probe() {
      await this.ensureBucket();
      const blobId = "bb".padEnd(32, "0");
      await this.put("probe", blobId, Buffer.from("probe"));
      const got = await this.get("probe", blobId);
      await this.delete("probe", blobId);
      return got.toString() === "probe";
    },
  };
}
