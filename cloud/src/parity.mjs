import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.mjs";

function num(value) {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Integer out of range");
  return n;
}

export function hashSharePassword(password) {
  if (typeof password !== "string" || password.length < 4 || password.length > 128) {
    throw new HttpError(400, "InvalidPassword", "Share password is not valid");
  }
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function sharePasswordMatches(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  const key = scryptSync(password, salt, 32, { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) });
  if (expected.length !== key.length) return false;
  return timingSafeEqual(expected, key);
}

async function activity(drive, tenantId, action, objectKey) {
  await drive.db.query(
    "insert into activity (id, tenant_id, action, object_key, at) values ($1, $2, $3, $4, $5)",
    [`act_${randomBytes(8).toString("hex")}`, tenantId, action, objectKey ?? null, new Date().toISOString()],
  );
}

/**
 * Extra Drive operations that sit beside the existing object API.
 * Unknown infrastructure stays explicit: mail delivery and device sync are not performed here.
 */
export async function runParity(drive, tenant, payload) {
  const op = payload.op;
  const bucket = payload.bucket;
  const key = payload.key;
  if (op === "trash" || op === "restore" || op === "star") {
    const row = await drive.db.getObject(tenant.id, bucket, key);
    if (!row) throw new HttpError(404, "NoSuchKey", "Object not found");
    if (op === "star") {
      await drive.db.query(
        "update objects set starred = $4 where tenant_id = $1 and bucket = $2 and object_key = $3",
        [tenant.id, bucket, key, payload.starred ? 1 : 0],
      );
    } else {
      await drive.db.query(
        "update objects set trashed_at = $4 where tenant_id = $1 and bucket = $2 and object_key = $3",
        [tenant.id, bucket, key, op === "trash" ? new Date().toISOString() : null],
      );
    }
    await activity(drive, tenant.id, op, key);
    return { status: 200, body: { ok: true } };
  }
  if (op === "versions") {
    const rows = await drive.db.query(
      "select id, size_bytes, content_type, created_at from versions where tenant_id = $1 and bucket = $2 and object_key = $3 order by created_at desc",
      [tenant.id, bucket, key],
    );
    return {
      status: 200,
      body: { versions: rows.map((row) => ({ ...row, size_bytes: num(row.size_bytes) })) },
    };
  }
  if (op === "restore-version") {
    const rows = await drive.db.query(
      "select * from versions where id = $1 and tenant_id = $2 and bucket = $3 and object_key = $4",
      [payload.versionId, tenant.id, bucket, key],
    );
    const version = rows[0];
    if (!version) throw new HttpError(404, "NoSuchVersion", "Version not found");
    const current = await drive.db.getObject(tenant.id, bucket, key);
    if (!current) throw new HttpError(404, "NoSuchKey", "Object not found");
    await drive.db.transaction(async (q) => {
      await q(
        `insert into versions (id, tenant_id, bucket, object_key, size_bytes, blob_id, sha256, plaintext_sha256, content_type, envelope_json, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          `ver_${randomBytes(8).toString("hex")}`,
          tenant.id,
          bucket,
          key,
          current.size_bytes,
          current.blob_id,
          current.sha256,
          current.plaintext_sha256,
          current.content_type,
          current.envelope_json,
          current.created_at,
        ],
      );
      await q(
        `update objects set size_bytes = $1, blob_id = $2, sha256 = $3, plaintext_sha256 = $4, content_type = $5, envelope_json = $6, created_at = $7, trashed_at = null
         where tenant_id = $8 and bucket = $9 and object_key = $10`,
        [
          version.size_bytes,
          version.blob_id,
          version.sha256,
          version.plaintext_sha256,
          version.content_type,
          version.envelope_json,
          version.created_at,
          tenant.id,
          bucket,
          key,
        ],
      );
    });
    await activity(drive, tenant.id, "restore-version", key);
    return { status: 200, body: { ok: true } };
  }
  if (op === "invite") {
    if (payload.role !== "viewer" && payload.role !== "editor") {
      throw new HttpError(400, "InvalidRole", "Role must be viewer or editor");
    }
    if (typeof payload.cid !== "string" || !/^cid_[a-z0-9_]{1,64}$/.test(payload.cid)) {
      throw new HttpError(400, "InvalidCid", "Cumulus://ID is not valid");
    }
    const row = await drive.db.getObject(tenant.id, bucket, key);
    if (!row) throw new HttpError(404, "NoSuchKey", "Object not found");
    if (payload.cid === tenant.cid) throw new HttpError(400, "InvalidCid", "Cannot invite the owner");
    const id = `gr_${randomBytes(8).toString("hex")}`;
    await drive.db.query(
      `insert into grants (id, tenant_id, bucket, object_key, grantee_cid, role, created_at, revoked_at)
       values ($1, $2, $3, $4, $5, $6, $7, null)`,
      [id, tenant.id, bucket, key, payload.cid, payload.role, new Date().toISOString()],
    );
    await activity(drive, tenant.id, "invite", key);
    return { status: 201, body: { id, role: payload.role, cid: payload.cid } };
  }
  if (op === "shared") {
    const rows = await drive.db.query(
      `select id, tenant_id, bucket, object_key, role from grants
       where grantee_cid = $1 and revoked_at is null order by created_at desc`,
      [tenant.cid],
    );
    return { status: 200, body: { grants: rows } };
  }
  if (op === "activity") {
    const rows = await drive.db.query(
      "select id, action, object_key, at from activity where tenant_id = $1 order by at desc limit 50",
      [tenant.id],
    );
    return { status: 200, body: { events: rows } };
  }
  if (op === "security") {
    return {
      status: 200,
      body: {
        twoFactor: "deferred",
        securityKeys: "deferred",
        authority: "id.cumuluscloud.app",
        sync: "deferred",
        mail: "deferred",
        reason:
          "2FA and security keys stay at Cumulus://ID. This host is not a trusted session origin. Desktop sync, offline file bodies, and mail delivery are not running in this process.",
      },
    };
  }
  throw new HttpError(404, "NotFound", "Unknown parity operation");
}

export async function readGranted(drive, cid, bucket, key) {
  const rows = await drive.db.query(
    `select tenant_id, role from grants
     where grantee_cid = $1 and bucket = $2 and object_key = $3 and revoked_at is null`,
    [cid, bucket, key],
  );
  const grant = rows[0];
  if (!grant) return null;
  return drive.readObject(grant.tenant_id, bucket, key);
}
