import http from "node:http";
import path from "node:path";
import { createServer, masterKeyFromEnv } from "./server.mjs";
import { assertNotLiveSupabase } from "./guard.mjs";
import { LIMITS } from "./limits.mjs";
import { loadConfig } from "./config.mjs";

/**
 * Local process entry. Refuses the live Supabase project unless an explicit
 * override is present. This file is not started by tests or by a deploy.
 */
const env = process.env;
for (const name of ["CUMULUS_KMS_MASTER_KEY", "CUMULUS_BOOTSTRAP_TOKEN", "CUMULUS_SHARE_SECRET"]) {
  if (!env[name] || env[name].length < 16) {
    console.error(`${name} is required. Refusing to start.`);
    process.exit(1);
  }
}
if (env.CUMULUS_S3_ENDPOINT) assertNotLiveSupabase(env.CUMULUS_S3_ENDPOINT);
if (env.DATABASE_URL) assertNotLiveSupabase(env.DATABASE_URL);

const config = loadConfig(env);
const dataDir = path.resolve(env.CUMULUS_DATA_DIR || "cloud/var");
const app = await createServer({
  config,
  masterKey: masterKeyFromEnv(env),
  bootstrapToken: env.CUMULUS_BOOTSTRAP_TOKEN,
  shareSecret: env.CUMULUS_SHARE_SECRET,
  issuer: config.issuer,
  audience: config.audience,
  jwksUrl: env.CUMULUS_KEYCLOAK_JWKS_JSON ? undefined : config.jwksUrl,
  jwks: env.CUMULUS_KEYCLOAK_JWKS_JSON ? JSON.parse(env.CUMULUS_KEYCLOAK_JWKS_JSON) : undefined,
  databaseUrl: env.DATABASE_URL,
  sqlitePath: env.DATABASE_URL ? undefined : path.join(dataDir, "drive.sqlite"),
  blobsDir: path.join(dataDir, "blobs"),
  storageDriver: env.CUMULUS_STORAGE_DRIVER || "filesystem",
  s3: {
    endpoint: env.CUMULUS_S3_ENDPOINT,
    region: env.CUMULUS_S3_REGION || "us-east-1",
    bucket: env.CUMULUS_S3_BUCKET,
    accessKeyId: env.CUMULUS_S3_ACCESS_KEY,
    secretAccessKey: env.CUMULUS_S3_SECRET_KEY,
    loopbackOnly: false,
  },
  limits: LIMITS,
});

const port = Number(env.CUMULUS_PORT || 8092);
const bind = env.CUMULUS_BIND || "127.0.0.1";
const server = http.createServer(app.handle);
server.listen(port, bind, () => {
  console.log(JSON.stringify({ msg: "cumulus-drive listening", bind, port, driver: env.CUMULUS_STORAGE_DRIVER || "filesystem", liveSupabase: false }));
});
