import { randomBytes } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { LIMITS } from "./limits.mjs";
import { authenticate, requirePurpose } from "./auth.mjs";
import { createEnvelope, sha256, signShare, verifyShare } from "./crypto.mjs";
import { log } from "./log.mjs";
import { corsHeaders } from "./config.mjs";

const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const NAME = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const CID = /^cid_[a-z0-9_]{1,64}$/;

function num(value) {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Integer out of range");
  return n;
}

function assertBucket(bucket) {
  if (!BUCKET.test(bucket) || bucket.includes("..")) {
    throw new HttpError(400, "InvalidBucketName", "Bucket name is not allowed");
  }
}

function assertKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) {
    throw new HttpError(400, "InvalidObjectName", "Object key is empty or too long");
  }
  if (key.includes("\0") || key.includes("\\") || key.startsWith("/")) {
    throw new HttpError(400, "InvalidObjectName", "Object key is not allowed");
  }
  if (key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new HttpError(400, "InvalidObjectName", "Object key is not allowed");
  }
}

function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function aadFor(tenantId, blobId) {
  return `${tenantId}\n${blobId}`;
}

async function tenantFromCid(db, cid) {
  const tenant = await db.getTenantByCid(cid);
  if (!tenant) throw new HttpError(403, "AccessDenied", "CID is not bound to a tenant");
  return tenant;
}

function quotaError(message) {
  const error = new HttpError(403, "QuotaExceeded", message);
  error.quota = true;
  return error;
}

/**
 * Cumulus Drive. Filesystem is the primary storage driver. Metadata and quotas
 * are in SQLite or local Postgres. Nothing here contacts the live Supabase project.
 */
export function createDrive(options) {
  const limits = { ...LIMITS, ...options.limits };
  const envelope = createEnvelope(options.masterKey);
  const db = options.db;
  const storage = options.storage;
  const now = options.now ?? (() => new Date());
  const metrics = options.metrics;

  async function putObject(tenant, bucket, objectKey, plaintext, contentType) {
    assertBucket(bucket);
    assertKey(objectKey);
    if (plaintext.length > limits.maxFileBytes) {
      throw quotaError("Object exceeds the per-file cap");
    }
    const blobId = randomBytes(16).toString("hex");
    const sealed = envelope.seal(plaintext, aadFor(tenant.id, blobId));
    const digest = sha256(sealed.ciphertext);
    await storage.put(tenant.id, blobId, sealed.ciphertext);
    let previousBlob = null;
    try {
      await db.transaction(async (q) => {
        const existingRows = await q(
          "select * from objects where tenant_id = $1 and bucket = $2 and object_key = $3",
          [tenant.id, bucket, objectKey],
        );
        const existing = existingRows[0];
        const tenantRows = await q("select * from tenants where id = $1", [tenant.id]);
        const current = tenantRows[0];
        const projectRows = await q(
          "select coalesce(sum(used_bytes), 0) as used_bytes from tenants",
        );
        const oldSize = existing ? num(existing.size_bytes) : 0;
        const deltaBytes = plaintext.length - oldSize;
        const deltaObjects = existing ? 0 : 1;
        const usedBytes = num(current.used_bytes) + deltaBytes;
        const usedObjects = num(current.used_objects) + deltaObjects;
        if (usedBytes > num(current.max_bytes) || usedObjects > num(current.max_objects)) {
          throw quotaError("Tenant quota exceeded");
        }
        if (num(projectRows[0].used_bytes) + deltaBytes > limits.projectBytes) {
          throw quotaError("Project storage cap exceeded");
        }
        if (existing) {
          previousBlob = existing.blob_id;
          await q(
            `update objects set size_bytes = $1, blob_id = $2, sha256 = $3, plaintext_sha256 = $4,
             content_type = $5, envelope_json = $6, created_at = $7
             where tenant_id = $8 and bucket = $9 and object_key = $10`,
            [
              plaintext.length,
              blobId,
              digest,
              sha256(plaintext),
              contentType,
              JSON.stringify(sealed.envelope),
              now().toISOString(),
              tenant.id,
              bucket,
              objectKey,
            ],
          );
        } else {
          await q(
            `insert into objects (
              tenant_id, bucket, object_key, size_bytes, blob_id, sha256, plaintext_sha256,
              content_type, envelope_json, created_at
            ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              tenant.id,
              bucket,
              objectKey,
              plaintext.length,
              blobId,
              digest,
              sha256(plaintext),
              contentType,
              JSON.stringify(sealed.envelope),
              now().toISOString(),
            ],
          );
        }
        await q("update tenants set used_bytes = $2, used_objects = $3 where id = $1", [
          tenant.id,
          usedBytes,
          usedObjects,
        ]);
      });
    } catch (error) {
      await storage.delete(tenant.id, blobId).catch(() => undefined);
      throw error;
    }
    if (previousBlob) await storage.delete(tenant.id, previousBlob).catch(() => undefined);
    return { size: plaintext.length, sha256: sha256(plaintext) };
  }

  async function readObject(tenantId, bucket, objectKey) {
    const row = await db.getObject(tenantId, bucket, objectKey);
    if (!row) throw new HttpError(404, "NoSuchKey", "Object not found");
    const ciphertext = await storage.get(tenantId, row.blob_id);
    if (sha256(ciphertext) !== row.sha256) {
      throw new HttpError(500, "ChecksumMismatch", "Stored bytes failed the checksum");
    }
    const plaintext = envelope.open(ciphertext, JSON.parse(row.envelope_json), aadFor(tenantId, row.blob_id));
    if (sha256(plaintext) !== row.plaintext_sha256) {
      throw new HttpError(500, "ChecksumMismatch", "Decrypted bytes failed the checksum");
    }
    return { plaintext, contentType: row.content_type, size: row.size_bytes };
  }

  async function deleteObject(tenant, bucket, objectKey) {
    let blobId = null;
    await db.transaction(async (q) => {
      const rows = await q(
        "select * from objects where tenant_id = $1 and bucket = $2 and object_key = $3",
        [tenant.id, bucket, objectKey],
      );
      const existing = rows[0];
      if (!existing) throw new HttpError(404, "NoSuchKey", "Object not found");
      blobId = existing.blob_id;
      const tenantRows = await q("select * from tenants where id = $1", [tenant.id]);
      const current = tenantRows[0];
      await q("delete from objects where tenant_id = $1 and bucket = $2 and object_key = $3", [
        tenant.id,
        bucket,
        objectKey,
      ]);
      await q("delete from shares where tenant_id = $1 and bucket = $2 and object_key = $3", [
        tenant.id,
        bucket,
        objectKey,
      ]);
      await q("update tenants set used_bytes = $2, used_objects = $3 where id = $1", [
        tenant.id,
        num(current.used_bytes) - num(existing.size_bytes),
        num(current.used_objects) - 1,
      ]);
    });
    if (blobId) await storage.delete(tenant.id, blobId).catch(() => undefined);
  }

  async function createShare(tenant, bucket, objectKey, ttlSeconds) {
    assertBucket(bucket);
    assertKey(objectKey);
    const row = await db.getObject(tenant.id, bucket, objectKey);
    if (!row) throw new HttpError(404, "NoSuchKey", "Object not found");
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) {
      throw new HttpError(400, "InvalidTtl", "Share links expire in 1 to 900 seconds");
    }
    const id = newId("shr");
    const exp = Math.floor(now().getTime() / 1000) + ttlSeconds;
    const createdAt = now().toISOString();
    await db.query(
      `insert into shares (id, tenant_id, bucket, object_key, expires_at, revoked_at, created_at)
       values ($1, $2, $3, $4, $5, null, $6)`,
      [id, tenant.id, bucket, objectKey, new Date(exp * 1000).toISOString(), createdAt],
    );
    const sig = signShare(options.shareSecret, id, exp);
    const base = String(options.publicBaseUrl || "").replace(/\/+$/, "");
    const path = `/v1/shared?shareId=${encodeURIComponent(id)}&exp=${exp}&sig=${sig}`;
    return {
      shareId: id,
      expiresAt: new Date(exp * 1000).toISOString(),
      url: `${base}${path}`,
    };
  }

  async function revokeShare(tenant, shareId) {
    const rows = await db.query("select * from shares where id = $1 and tenant_id = $2", [shareId, tenant.id]);
    if (!rows[0]) throw new HttpError(404, "NoSuchShare", "Share not found");
    await db.query("update shares set revoked_at = $2 where id = $1", [shareId, now().toISOString()]);
  }

  async function openShare(shareId, exp, sig) {
    const expNumber = Number(exp);
    if (!shareId || !Number.isInteger(expNumber) || !sig) {
      throw new HttpError(403, "AccessDenied", "Share link is not valid");
    }
    if (!verifyShare(options.shareSecret, shareId, expNumber, sig)) {
      throw new HttpError(403, "AccessDenied", "Share link is not valid");
    }
    if (Math.floor(now().getTime() / 1000) > expNumber) {
      throw new HttpError(403, "ExpiredToken", "Share link has expired");
    }
    const rows = await db.query("select * from shares where id = $1", [shareId]);
    const share = rows[0];
    if (!share || share.revoked_at) throw new HttpError(403, "AccessDenied", "Share link is not valid");
    if (Date.parse(share.expires_at) !== expNumber * 1000) {
      throw new HttpError(403, "AccessDenied", "Share link is not valid");
    }
    return readObject(share.tenant_id, share.bucket, share.object_key);
  }

  return {
    db,
    storage,
    limits,
    putObject,
    readObject,
    deleteObject,
    createShare,
    revokeShare,
    openShare,
    async usage(tenant) {
      const fresh = await db.getTenant(tenant.id);
      const project = await db.projectUsage();
      return {
        tenantId: fresh.id,
        cid: fresh.cid,
        usedBytes: fresh.used_bytes,
        usedObjects: fresh.used_objects,
        maxBytes: fresh.max_bytes,
        maxObjects: fresh.max_objects,
        projectUsedBytes: project.usedBytes,
        projectBytes: limits.projectBytes,
        maxFileBytes: limits.maxFileBytes,
      };
    },
  };
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { "content-length": String(payload.length), ...headers });
  res.end(payload);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8" });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, "EntityTooLarge", "Object exceeds the per-file cap"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

function objectPath(pathname) {
  const prefix = "/v1/objects/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return { bucket: decodeURIComponent(rest), key: null };
  return {
    bucket: decodeURIComponent(rest.slice(0, slash)),
    key: decodeURIComponent(rest.slice(slash + 1)),
  };
}

export function createHandler(drive, options) {
  const metrics = options.metrics;
  const allowlist = options.corsOrigins ?? [];
  return async function handle(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    const cors = corsHeaders(origin, allowlist);
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, headers) => writeHead(status, { ...cors, ...(headers || {}) });
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      metrics?.request("drive", req.method, 204);
      return;
    }
    let status = 500;
    try {
      status = await route(drive, options, req, res, url);
    } catch (error) {
      status = error instanceof HttpError ? error.status : 500;
      if (error instanceof HttpError && error.quota) metrics?.quotaDenied();
      if (!(error instanceof HttpError) || error.status === 401) metrics?.authFailure();
      if (!(error instanceof HttpError)) log("error", "drive error", { err: error.message });
      if (!res.headersSent) {
        const code = error instanceof HttpError ? error.code : "InternalError";
        const message = error instanceof HttpError ? error.message : "Internal error";
        sendJson(res, status, { error: { code, message } });
      }
    } finally {
      metrics?.request("drive", req.method, status);
    }
  };
}

async function route(drive, options, req, res, url) {
  if ((req.url || "").includes("..") || /%2e%2e/i.test(req.url || "")) {
    throw new HttpError(400, "InvalidObjectName", "Object key is not allowed");
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true, service: "cumulus-drive" });
    return 200;
  }
  if (req.method === "GET" && url.pathname === "/readyz") {
    const readyRow = (await drive.db.query("select 1 as ok"))[0];
    const dbOk = Number(readyRow?.ok) === 1;
    const storageOk = await drive.storage.probe();
    const ready = Boolean(dbOk && storageOk);
    options.metrics?.set("cumulus_ready", ready ? 1 : 0);
    sendJson(res, ready ? 200 : 503, { ok: ready, driver: drive.storage.kind, database: drive.db.kind });
    return ready ? 200 : 503;
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    const counts = await drive.db.counts();
    options.metrics?.set("cumulus_tenants", counts.tenants);
    options.metrics?.set("cumulus_objects", counts.objects);
    options.metrics?.set("cumulus_shares", counts.shares);
    options.metrics?.set("cumulus_bytes_stored", counts.bytes);
    send(res, 200, options.metrics.render(), { "content-type": "text/plain; version=0.0.4" });
    return 200;
  }
  if (req.method === "GET" && url.pathname === "/v1/limits") {
    sendJson(res, 200, {
      driver: drive.storage.kind,
      database: drive.db.kind,
      projectBytes: drive.limits.projectBytes,
      maxFileBytes: drive.limits.maxFileBytes,
      pausesWhenInactiveIfSwappedToSupabaseFreePlan: drive.limits.pausesWhenInactiveIfSwappedToSupabaseFreePlan,
      liveSupabase: false,
    });
    return 200;
  }
  if (req.method === "GET" && url.pathname === "/v1/shared") {
    const body = await drive.openShare(url.searchParams.get("shareId"), url.searchParams.get("exp"), url.searchParams.get("sig"));
    send(res, 200, body.plaintext, { "content-type": body.contentType });
    return 200;
  }
  if (req.method === "POST" && url.pathname === "/v1/tenants") {
    const principal = await authenticate(req, { ...options, allowBootstrap: true });
    if (principal.kind !== "bootstrap") throw new HttpError(403, "AccessDenied", "Bootstrap token required");
    const payload = JSON.parse((await readBody(req, 1_048_576)).toString("utf8") || "{}");
    if (!NAME.test(payload.name || "") || !CID.test(payload.cid || "")) {
      throw new HttpError(400, "InvalidTenant", "Tenant name and cid are required");
    }
    const maxBytes = payload.quota?.maxBytes ?? drive.limits.defaultTenantBytes;
    const maxObjects = payload.quota?.maxObjects ?? drive.limits.defaultTenantObjects;
    if (!Number.isSafeInteger(maxBytes) || !Number.isSafeInteger(maxObjects) || maxBytes < 0 || maxObjects < 0) {
      throw new HttpError(400, "InvalidQuota", "Quota must be a non-negative integer");
    }
    if (maxBytes > drive.limits.projectBytes) {
      throw new HttpError(400, "InvalidQuota", "Tenant quota cannot exceed the project cap");
    }
    const id = newId("tn");
    try {
      await drive.db.insertTenant({
        id,
        name: payload.name,
        cid: payload.cid,
        maxBytes,
        maxObjects,
        createdAt: (options.now ?? (() => new Date()))().toISOString(),
      });
    } catch (error) {
      if (String(error.message).includes("UNIQUE") || error.code === "23505") {
        throw new HttpError(409, "TenantExists", "Tenant name or CID already exists");
      }
      throw error;
    }
    sendJson(res, 201, { id, name: payload.name, cid: payload.cid, maxBytes, maxObjects });
    return 201;
  }

  const principal = await authenticate(req, options);
  const purpose = req.headers["x-cumulus-purpose"];
  const purposeValue = Array.isArray(purpose) ? purpose[0] : purpose;
  if (principal.hintedTenant) {
    const tenant = await tenantFromCid(drive.db, principal.cid);
    if (principal.hintedTenant !== tenant.id) {
      throw new HttpError(403, "AccessDenied", "Tenant hint does not match the CID");
    }
  }

  if (req.method === "GET" && url.pathname === "/v1/usage") {
    requirePurpose(principal, purposeValue, "usage.get");
    const tenant = await tenantFromCid(drive.db, principal.cid);
    sendJson(res, 200, await drive.usage(tenant));
    return 200;
  }

  if (req.method === "POST" && url.pathname === "/v1/shares") {
    requirePurpose(principal, purposeValue, "share.create");
    const tenant = await tenantFromCid(drive.db, principal.cid);
    const payload = JSON.parse((await readBody(req, 1_048_576)).toString("utf8") || "{}");
    const share = await drive.createShare(tenant, payload.bucket, payload.key, payload.ttlSeconds);
    sendJson(res, 201, share);
    return 201;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/v1/shares/")) {
    requirePurpose(principal, purposeValue, "share.revoke");
    const tenant = await tenantFromCid(drive.db, principal.cid);
    await drive.revokeShare(tenant, decodeURIComponent(url.pathname.slice("/v1/shares/".length)));
    send(res, 204, Buffer.alloc(0));
    return 204;
  }

  const located = objectPath(url.pathname);
  if (!located) throw new HttpError(404, "NotFound", "Unknown route");
  const tenant = await tenantFromCid(drive.db, principal.cid);

  if (req.method === "GET" && located.key === null) {
    requirePurpose(principal, purposeValue, "object.list");
    assertBucket(located.bucket);
    sendJson(res, 200, { objects: await drive.db.listObjects(tenant.id, located.bucket) });
    return 200;
  }
  if (req.method === "GET" && located.key !== null) {
    requirePurpose(principal, purposeValue, "object.get");
    const body = await drive.readObject(tenant.id, located.bucket, located.key);
    send(res, 200, body.plaintext, { "content-type": body.contentType, etag: `"${sha256(body.plaintext)}"` });
    return 200;
  }
  if (req.method === "PUT" && located.key !== null) {
    requirePurpose(principal, purposeValue, "object.put");
    const plaintext = await readBody(req, drive.limits.maxFileBytes);
    const contentType = req.headers["content-type"] || "application/octet-stream";
    const saved = await drive.putObject(
      tenant,
      located.bucket,
      located.key,
      plaintext,
      Array.isArray(contentType) ? contentType[0] : contentType,
    );
    sendJson(res, 200, saved);
    return 200;
  }
  if (req.method === "DELETE" && located.key !== null) {
    requirePurpose(principal, purposeValue, "object.delete");
    await drive.deleteObject(tenant, located.bucket, located.key);
    send(res, 204, Buffer.alloc(0));
    return 204;
  }
  throw new HttpError(405, "MethodNotAllowed", "Method is not allowed");
}
