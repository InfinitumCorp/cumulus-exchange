import { repository } from "./repository.mjs";
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

function qualify(sql) {
  return sql
    .replaceAll(/\btenants\b/g, "cumulus.tenants")
    .replaceAll(/\bobjects\b/g, "cumulus.objects")
    .replaceAll(/\bshares\b/g, "cumulus.shares");
}

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

export function migrationFile() {
  return migrationPath;
}
