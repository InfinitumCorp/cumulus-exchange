import { createMetrics } from "./metrics.mjs";
import { openDatabase } from "./db.mjs";
import { createFilesystemDriver, createS3Driver } from "./storage.mjs";
import { createKeycloakVerifier } from "./auth.mjs";
import { createDrive, createHandler } from "./drive.mjs";
import { parseMasterKey } from "./crypto.mjs";
import { assertNotLiveSupabase } from "./guard.mjs";

/**
 * Local Cumulus Drive. Default storage is the filesystem driver.
 * This factory does not contact Supabase.
 */
export async function createServer(options) {
  const db = options.db ?? (await openDatabase({ databaseUrl: options.databaseUrl, sqlitePath: options.sqlitePath }));
  let storage = options.storage;
  if (!storage) {
    if (options.storageDriver === "s3") {
      assertNotLiveSupabase(options.s3.endpoint);
      storage = createS3Driver({ ...options.s3, loopbackOnly: options.s3.loopbackOnly === true });
      await storage.ensureBucket();
    } else {
      storage = createFilesystemDriver(options.blobsDir);
    }
  }
  const metrics = options.metrics ?? createMetrics();
  const verifier =
    options.verifier ??
    createKeycloakVerifier({
      issuer: options.issuer,
      audience: options.audience,
      jwks: options.jwks,
      jwksUrl: options.jwksUrl,
    });
  const drive = createDrive({
    db,
    storage,
    masterKey: options.masterKey,
    shareSecret: options.shareSecret,
    limits: options.limits,
    now: options.now,
    metrics,
  });
  const handle = createHandler(drive, {
    verifier,
    bootstrapToken: options.bootstrapToken,
    metrics,
    now: options.now,
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
