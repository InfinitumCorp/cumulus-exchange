import { createMetrics } from "./metrics.mjs";
import { openDatabase } from "./db.mjs";
import { createFilesystemDriver, createS3Driver } from "./storage.mjs";
import { createKeycloakVerifier } from "./auth.mjs";
import { createDrive, createHandler } from "./drive.mjs";
import { parseMasterKey } from "./crypto.mjs";
import { assertNotLiveSupabase } from "./guard.mjs";
import { loadConfig } from "./config.mjs";
import { createSupabaseDriver } from "./supabase-storage.mjs";

/**
 * Local Cumulus Drive. Default storage is the filesystem driver.
 * This factory does not contact Supabase.
 */
export async function createServer(options) {
  const db = options.db ?? (await openDatabase({ databaseUrl: options.databaseUrl, sqlitePath: options.sqlitePath }));
  let storage = options.storage;
  if (!storage) {
    if (options.storageDriver === "supabase") {
      assertNotLiveSupabase(options.supabase.url);
      storage = createSupabaseDriver(options.supabase);
    } else if (options.storageDriver === "s3") {
      assertNotLiveSupabase(options.s3.endpoint);
      storage = createS3Driver({ ...options.s3, loopbackOnly: options.s3.loopbackOnly === true });
      await storage.ensureBucket();
    } else if (!options.storageDriver || options.storageDriver === "filesystem") {
      storage = createFilesystemDriver(options.blobsDir);
    } else {
      throw new Error(`Unsupported storage driver: ${options.storageDriver}`);
    }
  }
  const config = options.config ?? loadConfig(options.env ?? {});
  const metrics = options.metrics ?? createMetrics();
  const verifier =
    options.verifier ??
    createKeycloakVerifier({
      issuer: options.issuer ?? config.issuer,
      audience: options.audience ?? config.audience,
      jwks: options.jwks,
      jwksUrl: options.jwks ? undefined : (options.jwksUrl ?? config.jwksUrl),
    });
  const drive = createDrive({
    db,
    storage,
    masterKey: options.masterKey,
    shareSecret: options.shareSecret,
    limits: options.limits,
    now: options.now,
    metrics,
    publicBaseUrl: options.publicBaseUrl ?? config.publicBaseUrl,
  });
  const handle = createHandler(drive, {
    verifier,
    bootstrapToken: options.bootstrapToken,
    metrics,
    now: options.now,
    corsOrigins: options.corsOrigins ?? config.corsOrigins,
  });
  return {
    drive,
    handle,
    metrics,
    async close() {
      await db.close();
    },
  };
}

export function masterKeyFromEnv(env = process.env) {
  return parseMasterKey(env.CUMULUS_KMS_MASTER_KEY);
}
