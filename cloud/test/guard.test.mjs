import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LIMITS, SUPABASE_PROJECT } from "../src/limits.mjs";
import { assertNotLiveSupabase } from "../src/guard.mjs";
import { forbiddenLicense } from "../scripts/check-licenses.mjs";
import { createS3Driver } from "../src/storage.mjs";

const cloudRoot = fileURLToPath(new URL("..", import.meta.url));

test("defaults match the free-plan caps and the live project is refused", () => {
  assert.equal(LIMITS.projectBytes, 1_000_000_000);
  assert.equal(LIMITS.maxFileBytes, 50_000_000);
  assert.equal(LIMITS.defaultTenantBytes, 1_000_000_000);
  assert.equal(LIMITS.pausesWhenInactiveIfSwappedToSupabaseFreePlan, true);
  assert.throws(
    () => assertNotLiveSupabase(`https://${SUPABASE_PROJECT.ref}.supabase.co/storage/v1/s3`),
    /Refusing live Supabase/,
  );
  assert.throws(
    () =>
      createS3Driver({
        endpoint: `https://${SUPABASE_PROJECT.ref}.supabase.co/storage/v1/s3`,
        region: "eu-west-1",
        bucket: "drive",
        accessKeyId: "test",
        secretAccessKey: "test",
      }),
    /Refusing live Supabase/,
  );
});

test("license classifier blocks GPL, AGPL, and MinIO is not required", () => {
  assert.equal(forbiddenLicense("Apache-2.0"), null);
  assert.equal(forbiddenLicense("MIT"), null);
  assert.equal(forbiddenLicense("AGPL-3.0"), "AGPL");
  assert.equal(forbiddenLicense("GPL-3.0"), "GPL");
  assert.equal(forbiddenLicense("(MIT OR GPL-2.0)"), null);
});

function run(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: cloudRoot, env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

test("migrate and process startup refuse the live database", async () => {
  const migrated = await run("scripts/migrate.mjs", {
    DATABASE_URL: `postgres://postgres:secret@db.${SUPABASE_PROJECT.ref}.supabase.co:5432/postgres`,
  });
  assert.notEqual(migrated.code, 0);
  assert.match(migrated.stderr, /Refusing live Supabase/);
  const started = await run("src/main.mjs", {
    CUMULUS_KMS_MASTER_KEY: "aa".repeat(32),
    CUMULUS_BOOTSTRAP_TOKEN: "bootstrap-token-value",
    CUMULUS_SHARE_SECRET: "share-secret-value",
    CUMULUS_KEYCLOAK_JWKS_JSON: "{}",
    CUMULUS_S3_ENDPOINT: `https://${SUPABASE_PROJECT.ref}.supabase.co/storage/v1/s3`,
  });
  assert.notEqual(started.code, 0);
  assert.match(started.stderr, /Refusing live Supabase/);
});
