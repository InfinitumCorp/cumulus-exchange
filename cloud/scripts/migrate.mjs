import { readFile } from "node:fs/promises";
import { assertNotLiveSupabase } from "../src/guard.mjs";
import { migrationFile } from "../src/db.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required. Refusing to migrate.");
  process.exit(1);
}
try {
  assertNotLiveSupabase(databaseUrl);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const pg = await import("pg");
const Pool = pg.default?.Pool ?? pg.Pool;
const pool = new Pool({ connectionString: databaseUrl });
try {
  const sql = await readFile(migrationFile(), "utf8");
  await pool.query(sql);
  console.log(JSON.stringify({ msg: "local migration applied", schema: "cumulus", liveSupabase: false }));
} finally {
  await pool.end();
}
