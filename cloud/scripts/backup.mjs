import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "../src/atomic.mjs";
import { sha256 } from "../src/crypto.mjs";
import { openDatabase } from "../src/db.mjs";
import { createFilesystemDriver } from "../src/storage.mjs";

/**
 * Copy metadata and ciphertext blobs. The master key is not included.
 * @param {{ db: { dump: Function }, storage: { get: Function }, outDir: string }} input
 */
export async function backupDrive({ db, storage, outDir }) {
  const dump = await db.dump();
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const object of dump.objects) {
    const bytes = await storage.get(object.tenant_id, object.blob_id);
    if (sha256(bytes) !== object.sha256) {
      throw new Error(`Checksum mismatch for blob ${object.blob_id}`);
    }
    const relative = path.join("blobs", object.tenant_id, object.blob_id);
    await atomicWrite(path.join(outDir, relative), bytes);
    files.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length });
  }
  const tables = `${JSON.stringify(dump)}\n`;
  await atomicWrite(path.join(outDir, "tables.json"), tables);
  files.push({ path: "tables.json", sha256: sha256(Buffer.from(tables)), bytes: Buffer.byteLength(tables) });
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = {
    format: "cumulus-drive-backup-v1",
    createdAt: new Date().toISOString(),
    files,
    note: "Ciphertext and metadata only. The master key and share secret are not in this backup.",
  };
  await atomicWrite(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function restoreDrive({ db, storage, backupDir }) {
  if (!(await db.isEmpty())) {
    throw new Error("Refusing to restore over a database that already has tenants");
  }
  const manifest = JSON.parse(await readFile(path.join(backupDir, "manifest.json"), "utf8"));
  if (manifest.format !== "cumulus-drive-backup-v1") throw new Error("Unknown backup format");
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(backupDir, file.path));
    if (sha256(bytes) !== file.sha256 || bytes.length !== file.bytes) {
      throw new Error(`Backup file ${file.path} failed checksum verification`);
    }
  }
  const dump = JSON.parse(await readFile(path.join(backupDir, "tables.json"), "utf8"));
  for (const object of dump.objects) {
    const bytes = await readFile(path.join(backupDir, "blobs", object.tenant_id, object.blob_id));
    await storage.put(object.tenant_id, object.blob_id, bytes);
  }
  await db.transaction(async (q) => {
    for (const tenant of dump.tenants) {
      await q(
        `insert into tenants (id, name, cid, max_bytes, max_objects, used_bytes, used_objects, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tenant.id,
          tenant.name,
          tenant.cid,
          tenant.max_bytes,
          tenant.max_objects,
          tenant.used_bytes,
          tenant.used_objects,
          tenant.created_at,
        ],
      );
    }
    for (const object of dump.objects) {
      await q(
        `insert into objects (
          tenant_id, bucket, object_key, size_bytes, blob_id, sha256, plaintext_sha256,
          content_type, envelope_json, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          object.tenant_id,
          object.bucket,
          object.object_key,
          object.size_bytes,
          object.blob_id,
          object.sha256,
          object.plaintext_sha256,
          object.content_type,
          object.envelope_json,
          object.created_at,
        ],
      );
    }
    for (const share of dump.shares) {
      await q(
        `insert into shares (id, tenant_id, bucket, object_key, expires_at, revoked_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          share.id,
          share.tenant_id,
          share.bucket,
          share.object_key,
          share.expires_at,
          share.revoked_at,
          share.created_at,
        ],
      );
    }
  });
}

function parseCli(argv) {
  const base = path.basename(argv[1] || "");
  let index = 2;
  let command = base.startsWith("restore") ? "restore" : "backup";
  if (argv[2] === "backup" || argv[2] === "restore") {
    command = argv[2];
    index = 3;
  }
  const map = new Map();
  for (; index < argv.length; index += 2) map.set(argv[index], argv[index + 1]);
  return { command, map };
}

async function main() {
  const { command, map } = parseCli(process.argv);
  if (!map.get("--blobs") || !map.get("--dir") || (!map.get("--sqlite") && !map.get("--database-url"))) {
    console.error("Usage: node backup.mjs backup|restore --sqlite <file> --blobs <dir> --dir <backup>");
    process.exit(2);
  }
  const db = await openDatabase({ sqlitePath: map.get("--sqlite"), databaseUrl: map.get("--database-url") });
  const storage = createFilesystemDriver(map.get("--blobs"));
  try {
    if (command === "backup") await backupDrive({ db, storage, outDir: map.get("--dir") });
    else await restoreDrive({ db, storage, backupDir: map.get("--dir") });
  } finally {
    await db.close();
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const here = fileURLToPath(import.meta.url);
if (entry === here || path.basename(entry).startsWith("restore")) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
