import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertNotLiveSupabase } from "./guard.mjs";

const migrationPath = fileURLToPath(new URL("../migrations/001_cumulus_drive.sql", import.meta.url));

const SQLITE_DDL = `
create table if not exists tenants (
  id text primary key,
  name text not null unique,
  cid text not null unique,
  max_bytes integer not null,
  max_objects integer not null,
  used_bytes integer not null default 0,
  used_objects integer not null default 0,
  created_at text not null
);
create table if not exists objects (
  tenant_id text not null references tenants (id),
  bucket text not null,
  object_key text not null,
  size_bytes integer not null,
  blob_id text not null unique,
  sha256 text not null,
  plaintext_sha256 text not null,
  content_type text not null,
  envelope_json text not null,
  created_at text not null,
  primary key (tenant_id, bucket, object_key)
);
create table if not exists shares (
  id text primary key,
  tenant_id text not null references tenants (id),
  bucket text not null,
  object_key text not null,
  expires_at text not null,
  revoked_at text,
  created_at text not null
);
`;

function num(value) {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Integer out of range");
  return n;
}

function tenantRow(row) {
  if (!row) return null;
  return {
    ...row,
    max_bytes: num(row.max_bytes),
    max_objects: num(row.max_objects),
    used_bytes: num(row.used_bytes),
    used_objects: num(row.used_objects),
  };
}

function objectRow(row) {
  if (!row) return null;
  return { ...row, size_bytes: num(row.size_bytes) };
}

function qualify(sql) {
  return sql
    .replaceAll(/\btenants\b/g, "cumulus.tenants")
    .replaceAll(/\bobjects\b/g, "cumulus.objects")
    .replaceAll(/\bshares\b/g, "cumulus.shares")
    .replaceAll(/\bversions\b/g, "cumulus.versions")
    .replaceAll(/\bgrants\b/g, "cumulus.grants")
    .replaceAll(/\bactivity\b/g, "cumulus.activity");
}

export const PARITY_DDL = `
alter table objects add column trashed_at text;
alter table objects add column starred integer not null default 0;
alter table objects add column sealed_name text;
alter table objects add column preview_class text;
alter table shares add column password_hash text;
alter table shares add column max_downloads integer;
alter table shares add column download_count integer not null default 0;
create table if not exists versions (
  id text primary key,
  tenant_id text not null,
  bucket text not null,
  object_key text not null,
  size_bytes integer not null,
  blob_id text not null,
  sha256 text not null,
  plaintext_sha256 text not null,
  content_type text not null,
  envelope_json text not null,
  created_at text not null
);
create table if not exists grants (
  id text primary key,
  tenant_id text not null,
  bucket text not null,
  object_key text not null,
  grantee_cid text not null,
  role text not null,
  created_at text not null,
  revoked_at text
);
create table if not exists activity (
  id text primary key,
  tenant_id text not null,
  action text not null,
  object_key text,
  at text not null
);
`;

function chainLock() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * @param {{ databaseUrl?: string, sqlitePath?: string }} options
 */
export async function openDatabase(options) {
  if (options.databaseUrl) {
    assertNotLiveSupabase(options.databaseUrl);
    return openPostgres(options.databaseUrl);
  }
  if (!options.sqlitePath) throw new Error("sqlitePath or databaseUrl is required");
  return openSqlite(options.sqlitePath);
}

function openSqlite(sqlitePath) {
  const db = new DatabaseSync(sqlitePath);
  db.exec("pragma foreign_keys = on");
  db.exec("pragma journal_mode = wal");
  db.exec(SQLITE_DDL);
  for (const statement of PARITY_DDL.split(";").map((part) => part.trim()).filter(Boolean)) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error.message))) throw error;
    }
  }
  const locked = chainLock();
  const query = (sql, params = []) => {
    const ordered = [];
    const text = sql.replace(/\$(\d+)/g, (_, index) => {
      ordered.push(params[Number(index) - 1]);
      return "?";
    });
    const statement = db.prepare(text);
    if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) return statement.all(...ordered);
    statement.run(...ordered);
    return [];
  };
  const transaction = (fn) =>
    locked(async () => {
      db.exec("begin");
      try {
        const result = await fn(query);
        db.exec("commit");
        return result;
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    });
  return repository(query, transaction, () => {
    db.exec("pragma wal_checkpoint(truncate)");
    db.close();
  }, "sqlite");
}

async function openPostgres(databaseUrl) {
  const imported = await import("pg");
  const Pool = imported.default?.Pool ?? imported.Pool;
  const pool = new Pool({ connectionString: databaseUrl });
  const sql = await readFile(migrationPath, "utf8");
  await pool.query(sql);
  for (const statement of PARITY_DDL.split(";").map((part) => part.trim()).filter(Boolean)) {
    const sql = /^alter table/i.test(statement) ? statement.replace("add column", "add column if not exists") : statement;
    await pool.query(qualify(sql));
  }
  const locked = chainLock();

  async function onClient(fn) {
    const client = await pool.connect();
    try {
      const query = async (text, params = []) => {
        const result = await client.query(qualify(text), params);
        return result.rows;
      };
      return await fn(query);
    } finally {
      client.release();
    }
  }

  const query = (text, params) => onClient((q) => q(text, params));
  const transaction = (fn) =>
    locked(() =>
      onClient(async (q) => {
        await q("begin");
        try {
          const result = await fn(q);
          await q("commit");
          return result;
        } catch (error) {
          try {
            await q("rollback");
          } catch {
            /* connection already aborted */
          }
          throw error;
        }
      }),
    );
  return repository(query, transaction, () => pool.end(), "postgres");
}

function repository(query, transaction, close, kind) {
  let closed = false;
  return {
    kind,
    query,
    transaction,
    async close() {
      if (closed) return;
      closed = true;
      await close();
    },
    async getTenantByCid(cid) {
      const rows = await query("select * from tenants where cid = $1", [cid]);
      return tenantRow(rows[0]);
    },
    async getTenant(id) {
      const rows = await query("select * from tenants where id = $1", [id]);
      return tenantRow(rows[0]);
    },
    async insertTenant(row) {
      await query(
        `insert into tenants (id, name, cid, max_bytes, max_objects, used_bytes, used_objects, created_at)
         values ($1, $2, $3, $4, $5, 0, 0, $6)`,
        [row.id, row.name, row.cid, row.maxBytes, row.maxObjects, row.createdAt],
      );
    },
    async getObject(tenantId, bucket, objectKey) {
      const rows = await query(
        "select * from objects where tenant_id = $1 and bucket = $2 and object_key = $3",
        [tenantId, bucket, objectKey],
      );
      return objectRow(rows[0]);
    },
    async listObjects(tenantId, bucket, view = "active") {
      const mode = view === "trash" || view === "starred" || view === "photos" ? view : "active";
      const where =
        mode === "trash"
          ? "trashed_at is not null"
          : mode === "starred"
            ? "trashed_at is null and starred = 1"
            : mode === "photos"
              ? "trashed_at is null and (preview_class = 'image' or content_type like 'image/%')"
              : "trashed_at is null";
      const rows = await query(
        `select object_key, size_bytes, content_type, created_at, starred, trashed_at, sealed_name, preview_class
         from objects where tenant_id = $1 and bucket = $2 and ${where} order by object_key`,
        [tenantId, bucket],
      );
      return rows.map((row) => ({ ...row, size_bytes: num(row.size_bytes), starred: num(row.starred) }));
    },
    async projectUsage() {
      const rows = await query(
        "select coalesce(sum(used_bytes), 0) as used_bytes, coalesce(sum(used_objects), 0) as used_objects from tenants",
      );
      return { usedBytes: num(rows[0]?.used_bytes), usedObjects: num(rows[0]?.used_objects) };
    },
    async counts() {
      const tenants = await query("select count(*) as n from tenants");
      const objects = await query("select count(*) as n from objects");
      const shares = await query("select count(*) as n from shares");
      const usage = await this.projectUsage();
      return {
        tenants: num(tenants[0]?.n),
        objects: num(objects[0]?.n),
        shares: num(shares[0]?.n),
        bytes: usage.usedBytes,
      };
    },
    async dump() {
      return {
        tenants: (await query("select * from tenants order by id")).map(tenantRow),
        objects: (await query("select * from objects order by blob_id")).map(objectRow),
        shares: await query("select * from shares order by id"),
      };
    },
    async isEmpty() {
      const counts = await this.counts();
      return counts.tenants === 0 && counts.objects === 0 && counts.shares === 0;
    },
  };
}

export function migrationFile() {
  return migrationPath;
}
